// U10 marketplace descriptions/actions. External transports are supplied by
// their libraries and replaced by tests; write-capable calls retain DRY_RUN.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { any, route } from '../../router.js';
import { render, renderToString } from '../../view.js';
import { AmazonApi } from '../../lib/amazonApi.js';
import { EbayApi } from '../../lib/ebayApi.js';
import { EtsyClient } from '../../lib/etsy.js';
import { Houzz } from '../../lib/houzz.js';
import { Shopify } from '../../lib/shopify.js';
import { fetchU10Url, getAmzItemPage, getAmzOrderReport, loadAmzOrderIntoDb, requestAmzOrderReport } from './service.js';

const ROLES = ['admin', 'user', 'remote'];

function phpPrintR(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v] as const) : Object.entries(value as Record<string, unknown>);
  let out = `Array\n${indent}(\n`;
  for (const [key, child] of entries) {
    out += `${indent}    [${key}] => `;
    if (child !== null && typeof child === 'object') out += `${phpPrintR(child, indent + '    ')}\n`;
    else out += `${child ?? ''}\n`;
  }
  return `${out}${indent})`;
}

function html(reply: FastifyReply, body: string): FastifyReply {
  return reply.type('text/html; charset=UTF-8').send(body);
}

// Legacy getStoreDesc's feed request is intentionally kept behind the same
// fetch seam as Amazon's read-only page/report downloads.
async function storeDescription(productId: unknown): Promise<string> {
  const decoded = JSON.parse(await fetchU10Url(`http://www.angelisabella.com/index.php?route=feed/rest_api/product&key=averyverylongsecret&product_id=${productId}`)) as { products: Array<{ description: string; images: Array<{ image: string }> }> };
  const product = decoded.products[0];
  return `<html><body>${decodeHtml(product.description)}${product.images.map((image: { image: string }) => `<img src='//www.angelisabella.com/image/${image.image}' style='width:800px;' />`).join('')}</body></html>`;
}

function decodeHtml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#0*39;/gi, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function registerU10Routes(app: FastifyInstance): void {
  any(app, {
    path: '/ShopifyDesc', name: 'ShopifyDesc', roles: ROLES,
    handler: async (req, reply) => render(req, reply, 'shopifyDesc', { product: await new Shopify().call('GET', `admin/products/${input(req, 'product')}.json`) }),
  });
  any(app, {
    path: '/FulfillShopify', name: 'FulfillShopify', roles: ROLES,
    handler: async (req, reply) => {
      const orderId = input<string>(req, 'orderId');
      const detail = await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', String(orderId ?? '')).executeTakeFirst();
      const subOrderId = String(detail?.subOrderId ?? '').split('-');
      if (subOrderId.length > 0) {
        const fulfillment: Record<string, unknown> = { tracking_number: input(req, 'tracking'), notify_customer: true };
        const company = input(req, 'trackingCompany');
        if (company != null && company !== '') fulfillment.tracking_company = company;
        const result = await new Shopify().call('POST', `admin/orders/${subOrderId[0]}/fulfillments.json`, { fulfillment });
        const order = await db.selectFrom('os_grant_order').select('id').where('orderId', '=', String(orderId ?? '')).executeTakeFirst();
        // PHP dereferences null here; retain that fatal rather than silently doing nothing.
        if (order == null) throw new Error('Call to a member function save() on null');
        await db.updateTable('os_grant_order').set({ status: 'Done', updated_at: nowDb() } as never).where('id', '=', order.id).execute();
        return reply.send(result);
      }
      return html(reply, '');
    },
  });
  any(app, {
    path: '/getAmzImage', name: 'getAmzImage', roles: ROLES,
    handler: async (req, reply) => {
      const inv = await db.selectFrom('os_grant_inventory').selectAll().where('asin', '=', String(input(req, 'asin') ?? '')).executeTakeFirst();
      return inv == null ? reply.type('application/json; charset=utf-8').send(JSON.stringify('')) : reply.send(inv);
    },
  });
  any(app, {
    path: '/downloadAmzImage', name: 'downloadAmzImage', roles: ROLES,
    handler: async (req, reply) => {
      let jsObj: string | null = null;
      let output = '';
      try {
        const page = await getAmzItemPage(String(input(req, 'asin') ?? ''));
        const start = page.indexOf('colorImages');
        const end = page.indexOf('colorToAsin');
        if (end > start) {
          const source = page.slice(start, end);
          const initial = "colorImages = { 'initial': ";
          const jsonStart = source.indexOf(initial) + initial.length;
          const jsonEnd = source.toLowerCase().indexOf('}]}');
          jsObj = source.slice(jsonStart, jsonEnd + 2);
          const images = JSON.parse(jsObj.replace(/'/g, '"'));
          output += `${Object.keys(images[0].main)[0]}<hr>`;
          for (const image of images) output += `${phpPrintR(image)}<hr>`;
        }
      } catch {
        jsObj = null;
      }
      reply.type('text/html; charset=UTF-8');
      return reply.send(output + (await renderToString(req, 'amzPics', { jsObj })));
    },
  });
  any(app, { path: '/loadAmzOrderIntoDB', name: 'loadAmzOrderIntoDB', roles: ROLES, handler: async (_req, reply) => html(reply, await loadAmzOrderIntoDb()) });
  any(app, { path: '/RequestAmzOrderReport', name: 'RequestAmzOrderReport', roles: ROLES, handler: async (_req, reply) => html(reply, phpPrintR(await requestAmzOrderReport())) });
  any(app, { path: '/GetAmzOrderReport', name: 'GetAmzOrderReport', roles: ROLES, handler: async (_req, reply) => reply.send(await getAmzOrderReport()) });
  any(app, { path: '/Test', name: 'Test', roles: ROLES, handler: async (req, reply) => render(req, reply, 'test') });
  any(app, {
    path: '/TestAmzApi', name: 'Test', roles: ROLES,
    handler: async (_req, reply) => {
      const api = new AmazonApi();
      const listing = await api.getListing('1D-QI3C-HUGG');
      const summaries = listing.summaries;
      const attributes = listing.attributes;
      const productType = summaries[0].product_type;
      const itemName = summaries[0].item_name;
      const description = attributes.product_description[0].value;
      const strip = (value: string) => value.replace(/David's Bridal|David|Tiffany's|Tiffany|IN USA|Georgia/gi, '');
      const bullets = attributes.bullet_point.map((bullet: { value: string }) => ({ value: strip(bullet.value) }));
      // This legacy endpoint patches a live listing. Force the library's existing
      // DRY_RUN guard for this route so the port can never make that write.
      const dryRun = process.env.DRY_RUN;
      process.env.DRY_RUN = '1';
      try {
        await api.patchListing('1D-QI3C-HUGG', productType, strip(itemName), strip(description), bullets);
      } finally {
        if (dryRun === undefined) delete process.env.DRY_RUN;
        else process.env.DRY_RUN = dryRun;
      }
      return reply.send('');
    },
  });
  route(app, {
    verb: 'get', path: '/ebayDesc', name: 'ebayDesc', roles: ROLES,
    handler: async (req, reply) => {
      const parts = String(input(req, 'itemId') ?? '').split('|');
      const item = await new EbayApi().GetItemByLegacyId(parts[0], parts[1]);
      return html(reply, `<html><meta http-equiv="Content-Type" content="text/html;charset=utf-8" /><body>${item.description}</body></html>`);
    },
  });
  route(app, { verb: 'get', path: '/storeDesc', name: 'storeDesc', roles: ROLES, handler: async (req, reply) => html(reply, await storeDescription(input(req, 'pId'))) });
  route(app, {
    verb: 'get', path: '/etsyDesc', name: 'etsyDesc', roles: ROLES,
    handler: async (req, reply) => {
      const transactions = await new EtsyClient().getTransaction(String(input(req, 'tId') ?? ''));
      return html(reply, transactions.map((transaction) => `<pre>${transaction.description}</pre><br/>${transaction.images.map((image: { url_570xN: string }) => `<img src='${image.url_570xN}'  style='width:800px;'/>`).join('')}`).join(''));
    },
  });
  route(app, {
    verb: 'get', path: '/etsyListing', name: 'etsyListing', roles: ROLES,
    handler: async (req, reply) => {
      const listing = await new EtsyClient().getListingById(String(input(req, 'Id') ?? ''));
      return html(reply, `<pre>${listing.description}</pre><br/>${listing.images.map((image: { url_570xN: string }) => `<img src='${image.url_570xN}'  style='width:800px;'/>`).join('')}`);
    },
  });
  route(app, {
    verb: 'get', path: '/Houzz.ajax', name: 'Houzz.ajax', roles: ROLES,
    handler: async (_req: FastifyRequest, reply: FastifyReply) => reply.type('application/json; charset=utf-8').send(JSON.stringify(await new Houzz().getUnshippedOrders())),
  });
}
