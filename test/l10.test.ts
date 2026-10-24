// L10: AppSearch + Integrator ports (created by earlier tasks, committed here). Nothing external is called:
// every request goes through setAppSearchTransportForTests / setEtsyTransportForTests / setShopifyTransportForTests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { AppSearch, setAppSearchTransportForTests, type AppSearchRequest } from '../src/lib/appSearch.js';
import { setEtsyTransportForTests, type EtsyRequest, type EtsyResponse } from '../src/lib/etsy.js';
import { setShopifyTransportForTests, type ShopifyRequest, type ShopifyResponse } from '../src/lib/shopify.js';
import { Integrator } from '../src/lib/integrator.js';

const LISTING_ID = 'L10TEST';

const listingReply = (count: number): string =>
  JSON.stringify({
    count,
    results:
      count === 0
        ? []
        : [
            {
              listing_id: LISTING_ID,
              sku: 'L10-NOSUCHSKU',
              title: 'USA-test rose',
              description: '<p>desc</p>',
              price: 12.5,
              item_weight: 3,
              item_weight_unit: 'lb',
              creation_tsz: 1700000000,
              shop_section_id: 7,
              tags: ['rose', 'red'],
              Images: [{ url_fullxfull: 'https://img.etsy.com/1.jpg' }],
              Variations: [],
              Inventory: [],
            },
          ],
  });

describe('AppSearch (L10)', () => {
  let seen: AppSearchRequest[] = [];
  beforeEach(() => {
    seen = [];
    setAppSearchTransportForTests(async (req) => {
      seen.push(req);
      return 'ok';
    });
  });
  afterEach(() => setAppSearchTransportForTests(null));

  it('builds the search URL with the keyword unencoded and appends page>1', async () => {
    const search = new AppSearch();
    expect(await search.getAmzSearch('rose red')).toBe('ok');
    expect(seen).toEqual([
      {
        method: 'GET',
        url: 'https://www.amazon.com/s/ref=nb_sb_noss_2?url=search-alias%3Daps&field-keywords=rose red',
        headers: { Accept: 'application/json' },
      },
    ]);
    expect(await search.getAmzSearch('x', 3)).toBe('ok');
    expect(seen[1].url).toBe('https://www.amazon.com/s/ref=nb_sb_noss_2?url=search-alias%3Daps&field-keywords=x&page=3');
  });
});

describe('Integrator (L10)', () => {
  let etsyReplies: string[] = [];
  let shopifyCalls: ShopifyRequest[] = [];
  beforeEach(() => {
    etsyReplies = [];
    shopifyCalls = [];
    setEtsyTransportForTests(async (_req: EtsyRequest): Promise<EtsyResponse> => ({
      status: 200,
      reason: 'OK',
      body: etsyReplies.shift() ?? listingReply(0),
    }));
    setShopifyTransportForTests(async (req: ShopifyRequest): Promise<ShopifyResponse> => {
      shopifyCalls.push(req);
      return { status: 200, reason: 'OK', headers: {}, body: '{"product":{"id":4242}}' };
    });
  });
  afterEach(() => {
    setEtsyTransportForTests(null);
    setShopifyTransportForTests(null);
  });

  it('copyEtsyToShopify returns null for a count=0 listing without any Shopify call', async () => {
    etsyReplies = [listingReply(0)];
    const prd = await new Integrator().copyEtsyToShopify(LISTING_ID);
    expect(prd).toBeNull();
    expect(shopifyCalls).toEqual([]);
    const rows = await db.selectFrom('os_mappings').selectAll().where('fromValue', '=', LISTING_ID).execute();
    expect(rows).toEqual([]);
  });

  it('copyEtsyToShopify inserts: sends the PHP product payload and records the mapping', async () => {
    etsyReplies = [listingReply(1)];
    try {
      const prd = await new Integrator().copyEtsyToShopify(LISTING_ID);
      expect(prd).toEqual({ id: 4242 });
      expect(shopifyCalls).toHaveLength(1);
      expect(shopifyCalls[0].method).toBe('POST');
      expect(shopifyCalls[0].url.endsWith('/admin/products.json')).toBe(true);
      const sent = JSON.parse(shopifyCalls[0].body as string);
      expect(sent.product).toEqual({
        published: false,
        title: 'USA-test rose',
        body_html: '<p>desc</p>',
        images: [{ src: 'https://img.etsy.com/1.jpg' }],
        tags: 'rose,red',
        vendor: 'Angel Isabella Etsy Import',
        options: [],
        variants: [
          { option1: 'Default', price: 12.5, inventory_management: 'shopify', weight: 3, weight_unit: 'lb', barcode: '' },
        ],
        metafields: [
          { key: 'source_store', value: 'etsy', value_type: 'string', namespace: 'global' },
          { key: 'source_store_id', value: LISTING_ID, value_type: 'string', namespace: 'global' },
        ],
      });
      const rows = await db.selectFrom('os_mappings').selectAll().where('fromValue', '=', LISTING_ID).execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].mapType).toBe('etsy_shopify_product');
      expect(rows[0].toValue).toBe('4242');
    } finally {
      await db.deleteFrom('os_mappings').where('fromValue', '=', LISTING_ID).execute();
    }
  });
});
