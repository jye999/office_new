// U9: UnshippedController's legacy eBay actions. The read endpoints call the Trading API;
// test callers must install the lib/ebay transport seam and production callers must not use
// the mutating endpoints without DRY_RUN or an explicit cutover decision.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { any } from '../../router.js';
import { renderToString } from '../../view.js';
import { Ebay } from '../../lib/ebay.js';
import { sxCount, sxGet, sxJsonValue, sxList, sxPrintR, sxText, type Sx } from '../../lib/simplexml.js';
import { loadEbayOrdersIntoDb } from './ebayImport.js';

const ROLES = ['admin', 'user', 'remote'];
const html = (reply: FastifyReply, body: string) => reply.type('text/html; charset=UTF-8').send(body);
const jsonString = (reply: FastifyReply, value: unknown) => reply.type('application/json').send(JSON.stringify(value));
const imageSize = (url: string) => url.replace(/\$_1\./g, '$_57.');

// `geteBayImage` and `getRayeBayImage` are byte-for-byte duplicates in PHP.
// `PictureURL` can be a SimpleXML child collection; repeated children become an array in the lib's shape.
export function ebayImage(result: Sx, value: unknown): string | string[] {
  let picUrl = '';
  const pictures = sxGet(result, 'Item', 'Variations', 'Pictures');
  if (pictures !== undefined) {
    const sets = sxList(sxGet(pictures, 'VariationSpecificPictureSet'));
    for (const set of sets) {
      if (sxText(sxGet(set, 'VariationSpecificValue')) !== String(value ?? '')) continue;
      const urls = sxList(sxGet(set, 'PictureURL'));
      if (sxText(urls) !== '') picUrl = sxText(urls);
      else {
        const fallback = sxList(sxGet(sets[0], 'PictureURL'));
        picUrl = sxText(fallback);
      }
    }
  } else {
    const urls = sxGet(result, 'Item', 'PictureDetails', 'PictureURL');
    if (urls !== undefined) {
      if (sxCount(urls) > 1) return sxList(urls).map((url) => imageSize(sxText(url)));
      picUrl = sxText(urls);
    }
  }
  return imageSize(picUrl);
}

export function registerEbayImportRoutes(app: FastifyInstance): void {
  any(app, {
    path: '/getEbayItem', name: 'getEbayItem', roles: ROLES,
    handler: async (req, reply) => {
      const itemId = input(req, 'id');
      const result = await new Ebay().getItem(itemId);
      // PHP prints the SimpleXMLElement before returning the view.
      return html(reply, sxPrintR(result) + await renderToString(req, 'ebayPics', { itemId }));
    },
  });
  any(app, {
    path: '/getEbayOrder', name: 'getEbayOrder', roles: ROLES,
    handler: async (req, reply) => html(reply, JSON.stringify(sxJsonValue(await new Ebay().getOrder(input(req, 'id'))))),
  });
  any(app, {
    path: '/getEbayTran', name: 'getEbayTran', roles: ROLES,
    handler: async (req, reply) => html(reply, JSON.stringify(sxJsonValue(await new Ebay().getSaleRecordDetail(input(req, 'transId'), input(req, 'itemId'))))),
  });
  any(app, {
    path: '/updateEbayOrder', name: 'updateEbayOrder', roles: ROLES,
    handler: async (req, reply) => {
      const orderId = String(input(req, 'orderId') ?? '');
      const tracking = input(req, 'tracking');
      const result = await new Ebay().completeSales(input(req, 'itemId'), input(req, 'transId'), tracking);
      if (sxText(sxGet(result, 'Ack')) !== 'Success') return jsonString(reply, 'failed');
      const ts = nowDb();
      await db.insertInto('os_trackings').values({
        store: 'E', orderId, tracking: String(tracking ?? ''), Url: String(input(req, 'url') ?? ''),
        stampsTxId: String(input(req, 'stampsTxId') ?? ''), submissionStatus: 'Complete', created_at: ts, updated_at: ts,
      } as never).execute();
      return jsonString(reply, 'ok');
    },
  });
  any(app, {
    path: '/EbayComplete', name: 'EbayComplete', roles: ROLES,
    handler: async (req, reply) => reply.send(await new Ebay().completeSales(input(req, 'itemId'), input(req, 'transId'), input(req, 'tracking'))),
  });
  for (const [path, name, appName] of [['/geteBayImage', 'geteBayImage', 'ebay'], ['/getRayeBayImage', 'getRayeBayImage', 'raystore']] as const) {
    any(app, {
      path, name, roles: ROLES,
      handler: async (req, reply) => {
        const result = await new Ebay(appName).getItem(input(req, 'itemId'));
        const pic = ebayImage(result, input(req, 'value'));
        return Array.isArray(pic) ? reply.send(pic) : html(reply, pic);
      },
    });
  }
  for (const [path, name, store] of [['/UpdateEbayPic', 'UpdateEbayPic', 'E'], ['/UpdateRayEbayPic', 'UpdateRayEbayPic', 'R']] as const) {
    any(app, {
      path, name, roles: ROLES,
      handler: async (req, reply) => {
        // PHP mistakenly uses the literal LIKE pattern "%variant%", not the request value.
        const row = await db.selectFrom('os_grant_orderdetail').selectAll()
          .where('store', '=', store).where('orderId', '=', String(input(req, 'orderId') ?? ''))
          .where('asin', '=', String(input(req, 'itemId') ?? '')).where('variation', 'like', '%variant%').limit(1).executeTakeFirst();
        if (!row) throw new Error('Attempt to assign property "image" on null');
        await db.updateTable('os_grant_orderdetail').set({ image: String(input(req, 'url') ?? ''), updated_at: nowDb() } as never).where('id', '=', row.id).execute();
        return html(reply, '');
      },
    });
  }
  any(app, {
    path: '/loadeBayOrderIntoDB', name: 'loadeBayOrderIntoDB', roles: ROLES,
    handler: async (_req: FastifyRequest, reply: FastifyReply) => html(reply, await loadEbayOrdersIntoDb()),
  });
}
