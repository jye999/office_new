// T22c: /SalesReport and /SalesSnapshotReport. The SalesReport stored procedure exists only in production (not in the
// dev DB), so every `call SalesReport(...)` and every os_SalesSummary query is stubbed here; expected figures were
// computed by hand from the stubs, and the date ranges were diffed against PHP 7.4 on the server.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import type { RawBuilder } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerReportRoutes, snapshotDates } from '../src/modules/report/routes.js';
import { number_format, registerViewPlugins, round } from '../src/view.js';

const stub = vi.hoisted(() => ({
  calls: [] as unknown[][],
  summaryQueries: [] as unknown[][],
  procedureRows: [] as Record<string, unknown>[],
  summaryRows: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db.js')>();
  const sql = new Proxy(real.sql, {
    apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
      const text = args[0].join('?');
      if (text.startsWith('call SalesReport')) {
        stub.calls.push(args.slice(1));
        // mysql2 returns [result set, OK packet] for CALL
        return { execute: async () => ({ rows: [stub.procedureRows, { affectedRows: 0 }] }) };
      }
      if (text.includes('os_SalesSummary')) {
        // compile() flattens the nested conditional fragment into the bound parameters
        const values = (Reflect.apply(target, thisArg, args) as RawBuilder<unknown>).compile(real.db).parameters;
        stub.summaryQueries.push([...values]);
        return { execute: async () => ({ rows: stub.summaryRows[values.join('|')] ?? [] }) };
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  return { ...real, sql };
});

async function adminId(): Promise<number> {
  const row = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_users.id'])
    .where('os_roles.name', '=', 'admin')
    .executeTakeFirst();
  if (!row) throw new Error('no admin user in DB');
  return row.id;
}

async function get(url: string) {
  const id = await adminId();
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerReportRoutes(app);
  app.addHook('preHandler', async (req) => {
    (req.session as Record<string, unknown>)['user_id'] = id;
  });
  const res = await app.inject({ method: 'GET', url });
  await app.close();
  return res;
}

// Text of every <td> in each <tbody> row of #salesTable.
function tableRows(body: string): string[][] {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(body.slice(body.indexOf('id="salesTable"')))?.[1] ?? '';
  return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/\s+/g, ' ').trim()),
  );
}

beforeEach(() => {
  stub.calls.length = 0;
  stub.summaryQueries.length = 0;
  stub.procedureRows = [];
  stub.summaryRows = {};
  // Sunday 2026-10-25 13:00 America/New_York
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-25T17:00:00Z') });
});
afterEach(() => vi.useRealTimers());

describe('T22c /SalesReport', () => {
  it('calls SalesReport(start,end) and renders channel labels and price+tax+shipping', async () => {
    stub.procedureRows = [
      { channel: 'E', fulfillment: 'Merchant', orderNumber: 3, qty: '7', price: '100.1000', tax: '5.5000', shipping: '1.2500' },
      { channel: 'T3', fulfillment: 'Merchant', orderNumber: 1, qty: '1', price: null, tax: null, shipping: null },
      { channel: 'Amazon.com', fulfillment: 'Amazon', orderNumber: 2, qty: '2', price: '1234.5600', tax: '0.0000', shipping: '0.0000' },
    ];
    const res = await get('/SalesReport?start=2026-10-01&end=2026-10-24');
    expect(res.statusCode).toBe(200);
    expect(stub.calls).toEqual([['2026-10-01', '2026-10-24']]);
    expect(res.body).toContain("value='2026-10-01'");
    expect(res.body).toContain("value='2026-10-24'");
    expect(tableRows(res.body)).toEqual([
      ['Ebay', 'Merchant', '3', '7', '106.85'],
      ['Etsy3 - Rental', 'Merchant', '1', '1', '0.00'],
      ['Amazon.com', 'Amazon', '2', '2', '1,234.56'],
    ]);
  });

  it('defaults to 7 days ago .. today, and treats empty/blank params as absent (Laravel has())', async () => {
    await get('/SalesReport');
    await get('/SalesReport?start=&end=%20');
    expect(stub.calls).toEqual([['2026-10-18', '2026-10-25'], ['2026-10-18', '2026-10-25']]);
  });
});

describe('T22c /SalesSnapshotReport', () => {
  it('queries the PHP date ranges and renders per-channel and total figures', async () => {
    const s = (Channel: string, Fulfillment: string, Price: string) => ({ Channel, Fulfillment, Order: '1', QTY: '1', Price, Tax: '0', Shipping: '0' });
    stub.procedureRows = [
      { channel: 'S', fulfillment: 'Merchant', orderNumber: 1, qty: 1, price: '25.5000', tax: '0', shipping: '0' },
      { channel: 'T', fulfillment: 'Merchant', orderNumber: 1, qty: 1, price: '5.0000', tax: '0', shipping: '0' },
      { channel: 'Q', fulfillment: 'Nowhere', orderNumber: 1, qty: 1, price: '99.0000', tax: '0', shipping: '0' }, // not in YTD: ignored
    ];
    stub.summaryRows = {
      '2026-01-01': [s('S', 'Merchant', '1000.5000'), s('T', 'Merchant', '200.0000'), s('Zed', 'Foo', '5.0000')],
      '2026-10-24 00:00:00|2026-10-24 23:59:59': [s('S', 'Merchant', '10.0000')],
      '2026-10-12 00:00:00|2026-10-18 23:59:59': [s('S', 'Merchant', '50.0000')],
      '2026-10-01 00:00:00|2026-10-25 00:00:00': [s('S', 'Merchant', '300.0000')],
      '2025-01-01 00:00:00|2025-10-25 23:59:59': [s('S', 'Merchant', '900.0000')],
      '2025-10-01 00:00:00|2025-10-25 23:59:59': [s('S', 'Merchant', '250.0000')],
      '2025-10-25 00:00:00|2025-10-25 23:59:59': [s('S', 'Merchant', '7.0000')],
      '2025-10-01 00:00:00|2025-10-31 23:59:59': [s('S', 'Merchant', '400.0000')],
    };
    const res = await get('/SalesSnapshotReport');
    expect(res.statusCode).toBe(200);
    expect(stub.calls).toEqual([['2026-10-25 00:00:00', '2026-10-25 23:59:59']]);
    expect(stub.summaryQueries.map((q) => q.join('|')).sort()).toEqual(Object.keys(stub.summaryRows).sort());
    expect(res.body).toContain('2026-10-25 00:00:00  to 2026-10-25 23:59:59');
    expect(res.body).toContain('<td>2025-10-25 00:00:00 </td>');
    expect(tableRows(res.body)).toEqual([
      ['Shopify', 'Merchant', '10.00', '25.50', '7.00', '50.00', '325.50', '250.00', '30.20 %', '400.00', '372.00', '1,026.00', '900.00', '14.00 %'],
      ['Etsy', 'Merchant', '0', '5.00', '0', '0', '0', '0', '', '0', '0', '205.00', '0', ''],
      ['Zed', 'Foo', '0', '0', '0', '0', '0', '0', '', '0', '0', '5.00', '0', ''],
    ]);
    const totals = [...res.body.slice(res.body.indexOf('<tfoot>')).matchAll(/<strong>\s*(?:<span[^>]*>)?\s*([^<]*?)\s*(?:<\/span>)?\s*<\/strong>/g)].map((m) => m[1]);
    expect(totals).toEqual(['Total', '10.00', '30.50', '7.00', '50.00', '330.50', '250.00', '32.20 %', '400.00', '372.00', '1,236.00', '900.00', '37.33 %']);
  });

  it('shows N/A changes when there is no last-year base', async () => {
    const res = await get('/SalesSnapshotReport');
    expect(tableRows(res.body)).toEqual([]);
    expect(res.body.match(/N\/A/g)).toHaveLength(2);
  });

  it('snapshotDates matches PHP 7.4 strtotime/date (Sunday, leap-day and month-end cases)', () => {
    // Expected values produced by php 7.4 (America/New_York) running the original ReportController expressions.
    expect(snapshotDates(2026, 10, 25)).toMatchObject({ lastweekStart: '2026-10-12 00:00:00', lastweekEnd: '2026-10-18 23:59:59', lastyearMonthEnd: '2025-10-31 23:59:59' });
    expect(snapshotDates(2024, 2, 29)).toMatchObject({ lastyearToday: '2023-03-01 00:00:00', lastyearStart: '2023-02-01 00:00:00', lastyearMonthEnd: '2023-02-28 23:59:59', lastweekStart: '2024-02-19 00:00:00', lastweekEnd: '2024-02-25 23:59:59' });
    expect(snapshotDates(2026, 3, 31)).toMatchObject({ yesterdayStart: '2026-03-30 00:00:00', lastweekStart: '2026-03-23 00:00:00', thismonthStart: '2026-03-01 00:00:00' });
  });
});

describe('T22c PHP 7.4 number_format rounding', () => {
  it('rounds half away from zero after 15-digit pre-rounding', () => {
    expect(number_format(4301.7750000000005, 2)).toBe('4,301.78');
    expect(number_format(3840.9749999999999, 2)).toBe('3,840.98');
    expect(number_format(1.005, 2)).toBe('1.01');
    expect(number_format(-0.001, 2)).toBe('0.00');
    expect(round(-2.5)).toBe(-3);
  });
});
