// FrayunController (routes/web.php:220-222 — all Route::any, role:admin,user,remote).
// frayunBuyLabel goes through the Frayun lib, whose request() gates CreatePreToJson
// when DRY_RUN=1. The zone/rate chart reads happen before the (write) SOAP call.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { Frayun, zoneAndDiscountedRate } from '../../lib/frayun.js';
import { json_encode, phpEmpty, render, round, substr } from '../../view.js';
import { nowDb } from '../../db.js';

// PHP response()->json(): the body is a JSON literal even for plain strings.
function json(reply: FastifyReply, v: unknown) {
  reply.type('application/json; charset=utf-8');
  // Fastify sends string payloads raw; Laravel's json() encodes them
  if (typeof v === 'string' || v === null) return reply['send'](JSON.stringify(v));
  return reply['send'](v);
}

const MIDDLEWARE = ['web', 'role:admin,user,remote'];

// PHP (float) cast: ''/null -> 0, non-numeric -> 0.
function phpFloat(v: unknown): number {
  const n = Number(v ?? '');
  return Number.isFinite(n) ? n : 0;
}

const FROM_ADDRESS = {
  Company: 'Angel Isabella, LLC',
  Address1: '1550 Oak Industrial Lane',
  Address2: 'Ste F',
  City: 'Cumming',
  State: 'GA',
  ZIPCode: '30041',
  PostalCode: '30041',
  Country: 'US',
  PhoneNumber: '678-999-6232',
};

export function registerFrayunRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'any',
    path: '/frayunBuyLabel',
    name: 'frayunBuyLabel',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const address = input<Record<string, unknown>>(req, 'address');
      if (address && String(address['State'] ?? '').length > 2) address['State'] = Frayun.getStateAbbr(String(address['State'])) ?? String(address['State']);
      const orderId = input(req, 'orderId');
      let lb = input(req, 'lb');
      let oz = input(req, 'oz');
      const ref = input(req, 'ref');
      let length = input(req, 'length');
      let width = input(req, 'width');
      let height = input(req, 'height');
      const products = input<Record<string, unknown>[]>(req, 'products');
      const toAddress = input<Record<string, unknown>>(req, 'address');
      const shippingMethod = input(req, 'shippingMethod');

      if (oz === null || oz === undefined || phpEmpty(oz)) oz = 0;
      if (lb === null || lb === undefined || phpEmpty(lb)) lb = 0;
      if (shippingMethod === 'Priority Mail') {
        if (Number(lb) === 0 && Number(oz) < 16) lb = 1;
      }
      if (length === null || length === undefined || phpEmpty(length)) length = 1;
      const lengthInCm = round(phpFloat(length) * 2.54, 2);
      if (width === null || width === undefined || phpEmpty(width)) width = 1;
      const widthInCm = round(phpFloat(width) * 2.54, 2);
      if (height === null || height === undefined || phpEmpty(height)) height = 1;
      const heightInCm = round(phpFloat(height) * 2.54, 2);
      const volWeight = (lengthInCm * widthInCm * heightInCm) / 6000;

      let totalOz = Number(oz) || 0;
      if (Number(lb) >= 1) totalOz = Number(oz) + Number(lb) * 16;
      let serviceType = 'FIRST CLASS';
      if (totalOz >= 16 || shippingMethod === 'Priority Mail') serviceType = 'PRIORITY MAIL';

      // if it's 1 lb, add 2 oz to make it print 2lb label
      if (totalOz === 16) totalOz = 18;

      // PHP leaves $weightInKg unassigned for no path; 0 mirrors PHP's undefined-variable comparison
      let weightInKg = 0;
      if (totalOz > 16) {
        weightInKg = totalOz * 0.02835;
        if (volWeight > weightInKg) console.info(`cube weight ${volWeight} bigger than actual weight ${weightInKg}`);
      }

      if (totalOz >= 32) {
        if (totalOz % 16 === 0) {
          // even pounds, use 2 less oz
          totalOz = totalOz - 2;
          weightInKg = totalOz * 0.02835;
        }
      }

      const { zone, discountedRate } = await zoneAndDiscountedRate(substr(FROM_ADDRESS.ZIPCode, 0, 3), String(toAddress?.['ZIPCode'] ?? ''), totalOz, serviceType);
      console.info(`discountedRate ${discountedRate}`);
      if (totalOz < 16) {
        weightInKg = Math.floor(Number(totalOz) * 28.35) / 1000;
      }
      const productList = Array.isArray(products) ? products : [];
      for (let i = 0; i < productList.length; i++) {
        if (productList[i]?.['USD'] === '0') productList[i] = { ...productList[i], USD: '100' };
        if (productList[i]?.['SalePrice'] === '0') productList[i] = { ...productList[i], SalePrice: '100' };
      }
      console.info(`printing ${lb} lb${oz} oz total oz${totalOz} $weightInKg${weightInKg}`);

      if (weightInKg > 0) {
        const labelResponse = await new Frayun().buyLabel(
          orderId, FROM_ADDRESS, toAddress as Record<string, unknown>, ref, nowDb().slice(0, 10),
          weightInKg, lengthInCm, heightInCm, widthInCm, productList,
        );
        const decoded: Record<string, unknown>[] = JSON.parse(labelResponse);
        decoded[0] = { ...decoded[0], Zone: zone, DiscountedRate: discountedRate };
        // response()->json(<string>) double-encodes: the body is a JSON string literal
        return json(reply, json_encode(decoded));
      }
      return json(reply, 'failed');
    },
  });

  route(app, {
    verb: 'any',
    path: '/frayunBalance',
    name: 'frayunBalance',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const resp = await new Frayun().getBalance();
      const r = JSON.parse(resp);
      const result = Array.isArray(r) ? r[0] : null;
      return render(req, reply, 'frayunbalance', { result });
    },
  });

  route(app, {
    verb: 'any',
    path: '/frayunDownloadLabel',
    name: 'frayunDownloadLabel',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const dpdNo = input(req, 'dpdNo');
      const labelResponse = await new Frayun().downloadLabel(dpdNo);
      return json(reply, labelResponse);
    },
  });
}
