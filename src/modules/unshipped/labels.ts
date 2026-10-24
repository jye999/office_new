// UnshippedController label / printing routes (routes/web.php:149-151, 181-184, 206-208, 318-319, 403-404,
// role:admin,user,remote). Buying/shipping calls (Amazon createShipment, Houzz shipOrder) go through libs that
// refuse to send when DRY_RUN=1; the mass-print routes only enqueue a job on the shared redis queue.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { any, notFoundPage, route } from '../../router.js';
import { render, sendServer500 } from '../../view.js';
import { disk } from '../../storage.js';
import { AmazonApi, pascalizeModel } from '../../lib/amazonApi.js';
import { Houzz } from '../../lib/houzz.js';
import { dispatchAmzMassPrintLabel, dispatchFrayunMassPrintLabel, ozPlusLbTimes16 } from '../../lib/queueJobs.js';
import { saveChanges } from '../../lib/eloquent.js';
import type { Row } from './service.js';

const ROLES = ['admin', 'user', 'remote'];
const json = (reply: FastifyReply, v: unknown) => reply.type('application/json').send(v == null ? '{}' : JSON.stringify(v));
const html = (reply: FastifyReply, body: string) => reply.type('text/html; charset=UTF-8').send(body);

// `if(!is_numeric($oz)) $oz = 0; if(is_numeric($lb)) $oz = $oz + $lb*16;`
function weightOz(oz: unknown, lb: unknown): number {
  return ozPlusLbTimes16(oz, lb);
}

async function itemsToShip(orderId: unknown) {
  return db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', '=', String(orderId ?? '')).execute();
}

export function registerLabelRoutes(app: FastifyInstance): void {
  any(app, {
    path: '/GetLabel',
    name: 'GetLabel',
    roles: ROLES,
    handler: async (req, reply) => {
      const t = await db.selectFrom('os_trackings').selectAll().where('orderId', '=', String(input(req, 'orderId') ?? '')).orderBy('Id', 'desc').limit(1).executeTakeFirst();
      return json(reply, t ?? null);
    },
  });

  any(app, {
    path: '/GetHouzzLabel',
    name: 'GetHouzzLabel',
    roles: ROLES,
    handler: async (req, reply) => {
      const raw = await new Houzz().getShippingLabel(input(req, 'orderId'));
      return json(reply, safeJson(raw));
    },
  });
  any(app, {
    path: '/ShipHouzzOrder',
    name: 'ShipHouzzOrder',
    roles: ROLES,
    handler: async (req, reply) => {
      const raw = await new Houzz().shipOrder(input(req, 'orderId'));
      return json(reply, safeJson(raw));
    },
  });

  any(app, { path: '/PrintShipping', name: 'PrintShipping', roles: ROLES, handler: async (req, reply) => render(req, reply, 'PrintShipping', {}) });
  // view('barcode') — the file is Barcode.blade.php, so the lookup fails on a case-sensitive FS: "View [barcode] not found".
  any(app, { path: '/Barcode', name: 'Barcode', roles: ROLES, handler: async (req, reply) => sendServer500(req, reply) });

  any(app, {
    path: '/LabelCountReport',
    name: 'LabelCountReport',
    roles: ROLES,
    handler: async (_req, reply) => {
      const q = async (where: string) => (await sql<{ total: number }>`SELECT COUNT( * ) total FROM os_trackings WHERE ${sql.raw(where)}`.execute(db)).rows;
      return json(reply, {
        today: await q('created_at >= DATE( DATE_ADD( LOCALTIME( ) , INTERVAL - 3.5 HOUR ) )'),
        yesterday: await q("created_at >= DATE( DATE_ADD( LOCALTIME( ) , INTERVAL  '-1 4' DAY_HOUR ) )  AND created_at < DATE( DATE_ADD( LOCALTIME( ) , INTERVAL - 3.5 HOUR ) )"),
        seven: await q("created_at >= DATE( DATE_ADD( LOCALTIME( ) , INTERVAL  '-7 4' DAY_HOUR ) )"),
        thirty: await q("created_at >= DATE( DATE_ADD( LOCALTIME( ) , INTERVAL  '-30 4' DAY_HOUR ) )"),
      });
    },
  });

  // dispatch(new AmzMassPrintLabel(...)) / FrayunMassPrintLabel: the controller returns nothing (empty 200).
  const massArgs = (req: FastifyRequest) => ({
    orders: input(req, 'orders'),
    lb: input(req, 'lb'),
    oz: input(req, 'oz'),
    length: input(req, 'length'),
    width: input(req, 'width'),
    height: input(req, 'height'),
  });
  any(app, { path: '/getMultiAmzLabel', name: 'getMultiAmzLabel', roles: ROLES, handler: async (req, reply) => (await dispatchAmzMassPrintLabel(massArgs(req)), html(reply, '')) });
  any(app, { path: '/getMultiFrayunLabel', name: 'getMultiFrayunLabel', roles: ROLES, handler: async (req, reply) => (await dispatchFrayunMassPrintLabel(massArgs(req)), html(reply, '')) });

  // storeLabel($orderId, $url) is bound as a route action with no route parameters -> ArgumentCountError -> 500.
  route(app, { verb: 'post', path: '/storeLabel', name: 'storeLabel', roles: ROLES, handler: async (req, reply) => sendServer500(req, reply) });

  any(app, {
    path: '/getOrderLabel',
    name: 'getOrderLabel',
    roles: ROLES,
    handler: async (req, reply) => {
      let orderId = String(input(req, 'orderId') ?? '');
      if (orderId.slice(0, 1) === '#') orderId = orderId.slice(1);
      const labels = disk('labels');
      const send = async (file: string, type: string) => reply.type(type).send(await labels.get(file));
      const short = orderId.length <= 5;
      if (await labels.exists(`labels/${orderId}.png`)) return send(`labels/${orderId}.png`, 'image/png');
      if (short && (await labels.exists(`labels/#${orderId}.png`))) return send(`labels/#${orderId}.png`, 'image/png');
      if (await labels.exists(`labels/${orderId}.gif`)) return send(`labels/${orderId}.gif`, 'image/gif');
      if (await labels.exists(`labels/${orderId}.pdf`)) return send(`labels/${orderId}.pdf`, 'application/pdf');
      if (short && (await labels.exists(`labels/#${orderId}.pdf`))) return send(`labels/#${orderId}.pdf`, 'application/pdf');
      return notFoundPage(reply);
    },
  });

  any(app, {
    path: '/getS3Image',
    name: 'getS3Image',
    roles: ROLES,
    handler: async (req, reply) => {
      const path = String(input(req, 'path') ?? '');
      const s3 = disk('s3');
      if (await s3.exists(path)) return reply.type('image/png').send(await s3.get(path));
      return notFoundPage(reply);
    },
  });

  route(app, {
    verb: 'post',
    path: '/GetAmazonShippingService',
    name: 'GetAmazonShippingService',
    roles: ROLES,
    handler: async (req, reply) => {
      const orderId = input(req, 'orderId');
      const items = await itemsToShip(orderId);
      const oz = weightOz(input(req, 'oz'), input(req, 'lb'));
      const result = await new AmazonApi().getShippingRates(String(orderId ?? ''), input(req, 'length'), input(req, 'width'), input(req, 'height'), oz, items as never);
      return json(reply, pascalizeModel(result));
    },
  });

  route(app, {
    verb: 'post',
    path: '/GetAmazonShippingLabel',
    name: 'GetAmazonShippingLabel',
    roles: ROLES,
    handler: async (req, reply) => {
      const orderId = String(input(req, 'orderId') ?? '');
      const oz = weightOz(input(req, 'oz'), input(req, 'lb'));
      const items = await itemsToShip(orderId);
      const result = await new AmazonApi().createShipment(orderId, input(req, 'length'), input(req, 'width'), input(req, 'height'), oz, items as never, String(input(req, 'shippingServiceId') ?? ''));
      if (result == null) {
        console.error('GetAmazonShippingLabel');
        return json(reply, null);
      }
      const labels = disk('labels');
      const labelData = Buffer.from(String(result.label?.file_contents?.contents ?? ''), 'base64');
      const prefix = labels.pathPrefix().replace(/\/?$/, '/'); // Flysystem getPathPrefix() ends with a slash
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(`${prefix}labels`, { recursive: true });
      writeFileSync(`${prefix}labels/${orderId}.gz`, labelData);
      new AmazonApi().uncompress(`${prefix}labels/${orderId}.gz`, `${prefix}labels/${orderId}.png`);
      // PHP deletes `<orderId>.gz` (no labels/ prefix), which does not exist: the .gz stays. Kept.
      await labels.delete(`${orderId}.gz`);

      const gorder = (await db.selectFrom('os_grant_order').selectAll().where('orderId', '=', orderId).limit(1).executeTakeFirst()) as Row | undefined;
      if (gorder) await saveChanges('os_grant_order', gorder, { status: 'Done', updated_at: nowDb() });
      const ts = nowDb();
      // SAFETY: Tracking timestamps are written verbatim (Eloquent stamps both on insert).
      await db
        .insertInto('os_trackings')
        .values({ orderId, store: 'A', tracking: result.tracking_id, Url: result.shipment_id, localUrl: `${orderId}.png`, Amount: result.shipping_service?.rate?.amount ?? null, created_at: ts, updated_at: ts } as never)
        .execute();
      return json(reply, pascalizeModel(result));
    },
  });
}

// json_decode($s, true): invalid JSON -> null
function safeJson(s: unknown): Record<string, unknown> | unknown[] | null {
  try {
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}
