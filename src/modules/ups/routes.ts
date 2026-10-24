// UpsController (routes/web.php:423-426 — all Route::any, role:admin,user,remote).
// WRITE routes (getLabel -> /ShipConfirm + /ShipAccept, void -> /Void) go through the
// UpsClient lib, whose request() gates the write endpoints when DRY_RUN=1.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { UpsClient } from '../../lib/ups.js';
import { Stamps } from '../../lib/stamps.js';

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

// SAFETY: the lib types the street lines as string[]; nulls pass through as in PHP.
function streetOf(address: Record<string, unknown> | null): string[] {
  return [address?.['Address1'], address?.['Address2']] as unknown as string[];
}

export function registerUpsRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'any',
    path: '/ups.getrate',
    name: 'ups.getrate',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const address = fixState(input<Record<string, unknown>>(req, 'address'));
      let lb = input(req, 'lb');
      let oz = input(req, 'oz');
      const length = input(req, 'length');
      const width = input(req, 'width');
      const height = input(req, 'height');
      if (lb === '') lb = 0;
      if (oz === '') oz = 0;
      let weight = phpFloat(lb);
      if (Number(oz) > 0) weight += phpFloat(oz) / 16;

      // PHP: getRate($fromZip, $toZip, $weight, $height, $width, $length) — positional quirk in the lib
      const rate = await new UpsClient().getRate(WAREHOUSE_ADDRESS.Address.PostalCode, address?.['ZIPCode'], weight, length, width, height);
      return json(reply, rate);
    },
  });

  route(app, {
    verb: 'any',
    path: '/ups.getLabel',
    name: 'ups.getLabel',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const orderId = input(req, 'orderId');
      const store = input(req, 'store');
      const address = fixState(input<Record<string, unknown>>(req, 'address'));
      const packageType = input(req, 'ups-package');
      let lb = input(req, 'lb');
      let oz = input(req, 'oz');
      const length = input(req, 'length');
      const width = input(req, 'width');
      const height = input(req, 'height');
      if (lb === '') lb = 0;
      if (oz === '') oz = 0;
      let weight = phpFloat(lb);
      if (Number(oz) > 0) weight += phpFloat(oz) / 16;
      const ups = new UpsClient();

      const label =
        store === 'D'
          ? await ups.getLabel(
              orderId, orderId, WALMART_ADDRESS, packageType, length, width, height, weight,
              address?.['FullName'], address?.['PhoneNumber'], streetOf(address),
              address?.['City'], address?.['State'], address?.['ZIPCode'], address?.['Country'], true,
            )
          : await ups.getLabel(
              orderId, '', WAREHOUSE_ADDRESS, packageType, length, width, height, weight,
              address?.['FullName'], address?.['PhoneNumber'], streetOf(address),
              address?.['City'], address?.['State'], address?.['ZIPCode'], address?.['Country'], false,
            );

      if (label !== null) {
        const gorder = await db.selectFrom('os_grant_order').select(['id']).where('orderId', '=', String(orderId ?? '')).executeTakeFirst();
        if (gorder !== undefined) {
          // SAFETY: nowDb() is the app-tz 'YYYY-MM-DD HH:mm:ss' string the dateStrings pool (T00) writes verbatim.
          await db.updateTable('os_grant_order').set({ status: 'submit', updated_at: nowDb() as unknown as Date }).where('id', '=', gorder.id).execute();
        }
        const amount = label.netcharge !== undefined ? label.netcharge : 0;
        // SAFETY: values are the Eloquent fillable scalars + nowDb() dateStrings (T00); `as never` matches the T24 insert pattern.
        await db
          .insertInto('os_trackings')
          .values({
            orderId: String(orderId ?? ''),
            store: (store ?? null) as unknown as string | null, // SAFETY: request store is a short string
            tracking: label.tracking,
            Url: '',
            localUrl: `${orderId}.png`, // PHP quirk: controller stores .png even for UPS .gif labels
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
    path: '/ups.validate',
    name: 'ups.validate',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const address = fixState(input<Record<string, unknown>>(req, 'address'));
      // SAFETY: UpsClient types the street lines as string[]; nulls pass through as in PHP.
      const validAddress = await new UpsClient().validateAddress(
        [address?.['Address1'], address?.['Address2']] as string[], address?.['City'], address?.['State'], address?.['ZIPCode'],
      );
      return json(reply, validAddress);
    },
  });

  route(app, {
    verb: 'any',
    path: '/ups.void',
    name: 'ups.void',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const trackingNum = input(req, 'trackingNum');
      if (String(trackingNum ?? '').length > 0) {
        const response = await new UpsClient().deleteShipment(trackingNum as string);
        if (response?.Status?.StatusType?.Description === 'Success') {
          const track = await db.selectFrom('os_trackings').select(['Id']).where('tracking', '=', String(trackingNum)).executeTakeFirst();
          if (track) {
            // PHP: ->voided='true' into the numeric column -> 1
            await db.updateTable('os_trackings').set({ canceled: 'true', voided: 1 }).where('Id', '=', track.Id).execute();
          }
          // PHP: `return "OK"` — plain string, not JSON
          return reply.type('text/html; charset=UTF-8').send('OK');
        }
        return json(reply, response);
      }
    },
  });
}
