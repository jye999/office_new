// Port of the old app's App\Libraries\Integrator (Runner actions `etsy-shopify` / `etsy2-shopify`): copies Etsy listings
// into Shopify as unpublished products and records the Etsy->Shopify id pair in os_mappings.
// Ported (the only methods with callers): CopyAllEtsyToShopify -> copyAllEtsyToShopify, CopyEtsyToShopify ->
// copyEtsyToShopify. Skipped (no caller; the only call to CopyEtsyCategoriesToShopify is commented out in Runner):
// GetHiddenEstyCategoryInShopify, CopyEtsyCategoriesToShopify, CopyEtsyToShopifyByStore.
//
// All HTTP goes through EtsyClient (src/lib/etsy.ts request()) and Shopify (src/lib/shopify.ts request()). Shopify POST/PUT
// are write calls: with DRY_RUN=1 Shopify.call throws ShopifyDryRunError before anything is sent, so no os_mappings row is
// written either (the PHP only writes it after the product POST returned an id).

import { db, nowDb } from '../db.js';
import { date } from '../view.js';
import { EtsyClient } from './etsy.js';
import { Shopify } from './shopify.js';

// PHP foreach/sizeof over a decoded JSON array or object
const values = (x: unknown): any[] => (x !== null && typeof x === 'object' ? Object.values(x) : []);
const sizeof = (x: unknown): number => values(x).length;
const isPhpNumeric = (v: unknown): boolean => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

const log = (message: string): void => console.info(message);

export class Integrator {
  private hiddenEtsy = '';
  private etsyStore = 1;
  private etsy: EtsyClient;
  private shopify: Shopify;

  constructor() {
    this.etsy = new EtsyClient(this.etsyStore);
    this.shopify = new Shopify();
  }

  async copyAllEtsyToShopify(store = 1): Promise<void> {
    this.etsyStore = store;
    this.etsy = new EtsyClient(this.etsyStore);

    let page = 1;
    let results = await this.etsy.getAllListing(page);

    // PHP: $results['pagination']['next_page'] on null is null (no notice); on an array without the key it is an
    // "Undefined index" notice that Laravel's HandleExceptions turns into an ErrorException.
    const nextPage = (r: any): unknown => {
      if (r === null || typeof r !== 'object') return null;
      if (!('pagination' in r)) throw new Error('Undefined index: pagination');
      const p = r.pagination;
      if (p === null || typeof p !== 'object') return null;
      if (!('next_page' in p)) throw new Error('Undefined index: next_page');
      return p.next_page;
    };

    // PHP quirk: the page that carries the last (empty) next_page is never copied.
    while (nextPage(results) != null && nextPage(results) !== '' && isPhpNumeric(nextPage(results))) {
      process.stdout.write(`page ${page}\n`);
      if (results.results != null && sizeof(results.results) > 0) {
        for (const r of values(results.results)) {
          const prd = await this.copyEtsyToShopify(r.listing_id);
          console.log(prd);
        }
      }
      page = page + 1;
      await new Promise((resolve) => setTimeout(resolve, 1)); // usleep(500)
      results = await this.etsy.getAllListing(page);
    }
  }

  // Returns the Shopify reply of the PUT/POST, or null when nothing was sent (unmodified listing / no listing).
  async copyEtsyToShopify(etsyListingId: number | string): Promise<any> {
    log(`copying ${etsyListingId}`);
    const listingId = etsyListingId;
    const results = await this.etsy.getListingById(listingId);
    if (!(results !== null && typeof results === 'object' && results.count > 0)) return null;

    const listing = results.results[0];
    const tags = values(listing.tags).join(',');
    const imgArray = values(listing.Images).map((li) => ({ src: li.url_fullxfull }));
    let itemWeightUnit = 'oz';
    if (listing.item_weight_unit != '') itemWeightUnit = listing.item_weight_unit;

    const metafields = [
      { key: 'source_store', value: 'etsy', value_type: 'string', namespace: 'global' },
      { key: 'source_store_id', value: listingId, value_type: 'string', namespace: 'global' },
    ];
    // PHP strips 'USA-' into $title but then sends $listing['title'] (the stripped title is unused)
    let vendor = 'Angel Isabella Etsy Import';
    if (this.etsyStore == 2) vendor = 'Etsy Floral Supply Import';
    const newProduct: Record<string, any> = {
      published: false,
      title: listing.title,
      body_html: listing.description,
      images: imgArray,
      tags,
      vendor,
    };

    let variants: Record<string, any>[] = [];
    const options: { name: string; values: unknown[] }[] = [];
    if (sizeof(listing.Variations) > 0) {
      for (const la of values(listing.Variations)) {
        options.push({ name: la.formatted_name, values: values(la.options).map((ao) => ao.value) });
      }
    }
    newProduct.options = options;

    if (sizeof(listing.Inventory) > 0) {
      for (const la of values(listing.Inventory)) {
        for (const ao of values(la.products)) {
          if (variants.length >= 100) continue; // shopify can only take 100
          if (ao.is_deleted == 0) {
            const variant: Record<string, any> = { sku: ao.sku };
            const aiProduct = await db.selectFrom('os_products').select('upc').where('sku', '=', ao.sku).executeTakeFirst();
            if (aiProduct) variant.barcode = aiProduct.upc;
            variant.weight = listing.item_weight;
            variant.weight_unit = itemWeightUnit;
            let variantCounter = 1;
            for (const pv of values(ao.property_values)) {
              variant[`option${variantCounter}`] = values(pv.values)[0];
              variantCounter = variantCounter + 1;
              if (variantCounter > 3) break;
            }
            for (const offering of values(ao.offerings)) {
              variant.price = offering.price.amount / offering.price.divisor;
              variant.inventory_management = 'shopify';
              variant.inventory_quantity = offering.quantity;
            }
            variants.push(variant);
          }
        }
      }
    } else {
      const aiProduct = await db.selectFrom('os_products').select('upc').where('sku', '=', listing.sku).executeTakeFirst();
      const upc = aiProduct ? aiProduct.upc : '';
      variants = [
        { option1: 'Default', price: listing.price, inventory_management: 'shopify', weight: listing.item_weight, weight_unit: itemWeightUnit, barcode: upc },
      ];
    }
    newProduct.variants = variants;

    const maptype = this.etsyStore == 2 ? 'etsy2_shopify_product' : 'etsy_shopify_product';
    const prdMap = await db
      .selectFrom('os_mappings')
      .selectAll()
      .where('mapType', '=', maptype)
      .where('fromValue', '=', String(listingId))
      .executeTakeFirst();

    if (prdMap) {
      // PHP compares 'm/d/Y H:i:s' with the 'Y-m-d H:i:s' updated_at as plain strings
      const listingModifiedDate = date('m/d/Y H:i:s', listing.creation_tsz);
      if (listingModifiedDate > (prdMap.updated_at as unknown as string)) {
        log('updating ');
        const prdId = prdMap.toValue;
        log(`shopify id  ${prdId}`);
        const prd = await this.shopify.call('PUT', `admin/products/${prdId}.json`, { product: newProduct });
        log('updating done');
        return prd;
      }
      log('unmodified listing, no update');
      return null;
    }

    newProduct.metafields = metafields;
    log('insert listing');
    let prd = await this.shopify.call('POST', 'admin/products.json', { product: newProduct });
    if (prd !== null && typeof prd === 'object' && prd.id !== undefined && prd.id !== null) {
      const prdId = prd.id;
      log(`shopify id  ${prdId}`);
      log('insert done');

      const catmaptype = this.etsyStore == 2 ? 'etsy2_cat_shopify_cat' : 'etsy_cat_shopify_cat';
      const catMap = await db
        .selectFrom('os_mappings')
        .selectAll()
        .where('mapType', '=', catmaptype)
        .where('fromValue', '=', String(listing.shop_section_id))
        .executeTakeFirst();
      if (catMap) {
        prd = await this.shopify.call('POST', 'admin/collects.json', { collect: { product_id: prdId, collection_id: catMap.toValue } });
      }
      const now = nowDb();
      await db
        .insertInto('os_mappings')
        .values({ mapType: maptype, fromValue: String(listingId), toValue: String(prdId), created_at: now as any, updated_at: now as any })
        .execute();
    } else {
      console.log(prd);
    }
    return prd;
  }
}

