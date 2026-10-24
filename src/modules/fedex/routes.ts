// FedexController (routes/web.php:417-421 — all Route::any, role:admin,user,remote).
// WRITE routes (getLabel -> processShipment, void -> deleteShipment) go through the
// FedexClient lib, whose request() gates the write ops when DRY_RUN=1.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { FedexClient } from '../../lib/fedex.js';
import { Stamps, type StampsAddress } from '../../lib/stamps.js';

// PHP response()->json(): the body is a JSON literal even for plain strings.
function json(reply: FastifyReply, v: unknown) {
  reply.type('application/json; charset=utf-8');
  // Fastify sends string payloads raw; Laravel's json() encodes them
  if (typeof v === 'string' || v === null) return reply['send'](JSON.stringify(v));
  return reply['send'](v);
}

const MIDDLEWARE = ['web', 'role:admin,user,remote'];

const WAREHOUSE_ADDRESS = {
  Contact: { CompanyName: 'Angel Isabella LLC', PhoneNumber: '6789996232' },
  Address: {
    StreetLines: ['1550 Oak Industrial Lane', 'Ste F'],
    City: 'Cumming',
    StateOrProvinceCode: 'GA',
    PostalCode: 30041,
    CountryCode: 'US',
  },
};

const WALMART_ADDRESS = {
  Contact: { CompanyName: 'Walmart.com', PhoneNumber: '9133443980' },
  Address: {
    StreetLines: ['1901 SE 10TH ST', ''],
    City: 'BENTONVILLE',
    StateOrProvinceCode: 'AR',
    PostalCode: 72712,
    CountryCode: 'US',
  },
};

// PHP: strlen($address['State']) > 2 -> Stamps::getStateAbbr; null/missing -> 0.
function fixState(address: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!address) return address;
  if (String(address['State'] ?? '').length > 2) address['State'] = Stamps.getStateAbbr(String(address['State']));
  return address;
}

// PHP (float) cast: ''/null -> 0, non-numeric -> 0.
function phpFloat(v: unknown): number {
  const n = Number(v ?? '');
  return Number.isFinite(n) ? n : 0;
}

export function registerFedexRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'any',
    path: '/fedex.getOneRate',
    name: 'fedex.getOneRate',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const address = fixState(input<Record<string, unknown>>(req, 'address'));
      const isResidential = input(req, 'isResidential');
      let lb = input(req, 'lb');
      let oz = input(req, 'oz');
      const length = input(req, 'length');
      const width = input(req, 'width');
      const height = input(req, 'height');
      const packaging = input(req, 'packaging');
      let serviceType = input(req, 'serviceType');
      // PHP loose: $serviceType==null && $serviceType=='' is null == '' (true)
      if (serviceType === null || serviceType === undefined || serviceType === '') serviceType = 'FEDEX_EXPRESS_SAVER';
      if (lb === '') lb = 0;
      if (oz === '') oz = 0;
      let weight = phpFloat(lb);
      if (Number(oz) > 0) weight += phpFloat(oz) / 16;

      const rate = await new FedexClient().getOneRate(
        WAREHOUSE_ADDRESS, length, width, height, weight, packaging, isResidential,
        [address?.['Address1'], address?.['Address2']], address?.['City'], address?.['State'], address?.['ZIPCode'],
        'US', serviceType,
      );
      return json(reply, rate);
    },
  });

  route(app, {
    verb: 'any',
    path: '/fedex.getrate',
    name: 'fedex.getrate',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const address = fixState(input<Record<string, unknown>>(req, 'address'));
      let lb = input(req, 'lb');
      let oz = input(req, 'oz');
      const length = input(req, 'length');
      const width = input(req, 'width');
      const height = input(req, 'height');
      const isResidential = input(req, 'isResidential') === 'true';
      const signature = input(req, 'signature') === 'true';
      if (lb === '') lb = 0;
      if (oz === '') oz = 0;
      let weight = phpFloat(lb);
      if (Number(oz) > 0) weight += phpFloat(oz) / 16;

      const rate = await new FedexClient().getRate(
        WAREHOUSE_ADDRESS, length, width, height, weight, isResidential, signature,
        [address?.['Address1'], address?.['Address2']], address?.['City'], address?.['State'], address?.['ZIPCode'],
      );
      return json(reply, rate);
    },
  });

  route(app, {
    verb: 'any',
    path: '/fedex.getLabel',
    name: 'fedex.getLabel',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const orderId = input(req, 'orderId');
      const store = input(req, 'store');
      const address = fixState(input<Record<string, unknown>>(req, 'address'));
      const isResidential = input(req, 'isResidential') === 'true';
      const signature = input(req, 'signature') === 'true';
      const packageType = input(req, 'fedex-package');
      let lb = input(req, 'lb');
      let oz = input(req, 'oz');
      const length = input(req, 'length');
      const width = input(req, 'width');
      const height = input(req, 'height');
      let serviceType = input(req, 'serviceType');
      if (serviceType === null || serviceType === undefined || serviceType === '') serviceType = 'FEDEX_EXPRESS_SAVER';
      if (packageType === 'FEDEX_GROUND') serviceType = 'FEDEX_GROUND';
      if (lb === '') lb = 0;
      if (oz === '') oz = 0;
      let weight = phpFloat(lb);
      if (Number(oz) > 0) weight += phpFloat(oz) / 16;
      const fedex = new FedexClient();

      const label =
        store === 'D'
          ? await fedex.getLabel(
              orderId, orderId, WALMART_ADDRESS, packageType, serviceType, length, width, height, weight,
              isResidential, signature, address?.['FullName'], address?.['PhoneNumber'],
              [address?.['Address1'], address?.['Address2']], address?.['City'], address?.['State'], address?.['ZIPCode'],
              address?.['Country'], true,
            )
          : await fedex.getLabel(
              orderId, '', WAREHOUSE_ADDRESS, packageType, serviceType, length, width, height, weight,
              isResidential, signature, address?.['FullName'], address?.['PhoneNumber'],
              [address?.['Address1'], address?.['Address2']], address?.['City'], address?.['State'], address?.['ZIPCode'],
              address?.['Country'], false,
            );

      if (label !== null) {
        const gorder = await db.selectFrom('os_grant_order').select(['id']).where('orderId', '=', String(orderId ?? '')).executeTakeFirst();
        if (gorder !== undefined) {
          // SAFETY: nowDb() is the app-tz 'YYYY-MM-DD HH:mm:ss' string the dateStrings pool (T00) writes verbatim.
          await db.updateTable('os_grant_order').set({ status: 'submit', updated_at: nowDb() as unknown as Date }).where('id', '=', gorder.id).execute();
        }
        const amount = label.netcharge !== undefined ? label.netcharge : 0;
        await db
          .insertInto('os_trackings')
          // SAFETY: values are the Eloquent fillable scalars + nowDb() dateStrings (T00); `as never` matches the T24 insert pattern.
          .values({
            orderId: String(orderId ?? ''),
            store: (store ?? null) as unknown as string | null, // SAFETY: request store is a short string
            tracking: label.tracking,
            Url: '',
            localUrl: `${orderId}.png`,
            Amount: amount,
            created_at: nowDb() as unknown as Date, // SAFETY: nowDb() dateStrings written verbatim (T00)
            updated_at: nowDb() as unknown as Date, // SAFETY: same
          } as never)
          .execute();
        return json(reply, label);
      }
      return json(reply, 'error');
    },
  });

  route(app, {
    verb: 'any',
    path: '/fedex.validate',
    name: 'fedex.validate',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const address = fixState(input<Record<string, unknown>>(req, 'address'));
      const validAddress = await new FedexClient().validateAddress(
        [address?.['Address1'], address?.['Address2']], address?.['City'], address?.['State'], address?.['ZIPCode'],
      );
      return json(reply, validAddress);
    },
  });

  route(app, {
    verb: 'any',
    path: '/fedex.void',
    name: 'fedex.void',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const trackingNum = input(req, 'trackingNum');
      if (String(trackingNum ?? '').length > 0) {
        const status = await new FedexClient().deleteShipment(trackingNum as string);
        if (status === 'OK') {
          const track = await db.selectFrom('os_trackings').select(['Id']).where('tracking', '=', String(trackingNum)).executeTakeFirst();
          if (track) {
            // PHP: ->voided='true' into the numeric column -> 1
            await db.updateTable('os_trackings').set({ canceled: 'true', voided: 1 }).where('Id', '=', track.Id).execute();
          }
        }
        return json(reply, status);
      }
    },
  });
}
