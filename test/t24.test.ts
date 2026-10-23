// T24: PDA API (routes/api.php:26,67-78). GET endpoints are checked against
// direct DB reads; write endpoints run a full lifecycle on a temp product and
// clean up every row they create (product, locations, receiving lines,
// transactions, api token).

import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, nowDb, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerPdaRoutes } from '../src/modules/pda/routes.js';

const TOKEN_PLAIN = `t24-${randomBytes(24).toString('hex')}`;
const TOKEN_USER_ID = 1; // any existing user (T02 guard: token + user lookup)
const TEMP_SKU = 'T24TESTSKU';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  registerPdaRoutes(app);
  await app.ready();
  return app;
}

const KEY = (url = ''): Record<string, string> => ({ authorization: `Bearer ${TOKEN_PLAIN}` });

describe('T24 PDA API (fastify inject, live DB)', () => {
  beforeAll(async () => {
    await db
      .insertInto('os_user_api_tokens')
      .values({
        user_id: TOKEN_USER_ID,
        name: 'pda',
        token_hash: createHash('sha256').update(TOKEN_PLAIN).digest('hex'),
        token_hint: TOKEN_PLAIN.slice(0, 10),
        created_at: nowDb() as unknown as Date, // SAFETY: dateStrings pool (T00)
        updated_at: nowDb() as unknown as Date,
      } as never)
      .execute();
  });

  afterAll(async () => {
    // full cleanup of every temp row
    await db.deleteFrom('os_pda_inventory_transactions').where('sku', '=', TEMP_SKU).execute();
    await db.deleteFrom('os_pda_receiving_lines').where('sku', '=', TEMP_SKU).execute();
    const leftover = await db.selectFrom('os_products').select(['id']).where('sku', '=', TEMP_SKU).execute();
    for (const r of leftover) await db.deleteFrom('os_product_locations').where('product_id', '=', r.id).execute();
    await db.deleteFrom('os_products').where('sku', '=', TEMP_SKU).execute();
    await db.deleteFrom('os_user_api_tokens').where('user_id', '=', TOKEN_USER_ID).execute();
  });

  it('guards: no key / bad key -> 401 with the old app bodies', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/api/pda/location?location=X' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ message: 'API key required' });
    res = await app.inject({ method: 'GET', url: '/api/pda/location?location=X', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ message: 'Invalid API key' });
    await app.close();
  });

  it('/api/pda/location: 422 missing, rows+product with $appends vs direct DB', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/api/pda/location', headers: KEY() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ message: 'location is required' });

    res = await app.inject({ method: 'GET', url: '/api/pda/location?location=S12L2M', headers: KEY() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.location).toBe('S12L2M');
    const direct = await db
      .selectFrom('os_product_locations')
      .selectAll()
      .where(sql`UPPER(TRIM(os_product_locations.location))`, '=', 'S12L2M')
      .orderBy('id')
      .execute();
    expect(body.rows).toHaveLength(direct.length);
    expect(direct.length).toBeGreaterThan(0);
    for (const row of body.rows as Record<string, unknown>[]) {
      const dbRow = direct.find((d) => d.id === row.id);
      expect(dbRow).toBeDefined();
      for (const [k, v] of Object.entries(dbRow as Record<string, unknown>)) {
        if (k !== 'product') expect(row[k]).toEqual(v);
      }
      const p = row.product as Record<string, unknown>;
      expect(p.id).toBe(dbRow?.product_id);
      const sku = await productSku(p.id as number);
      expect(p.type).toBe(String(sku ?? '').charAt(0));
      expect(p.sku_num).toBe(String(sku ?? '').slice(1));
    }
    await app.close();
  });

  async function productSku(id: number): Promise<string | null> {
    const r = await db.selectFrom('os_products').select(['sku']).where('id', '=', id).executeTakeFirst();
    return r ? r.sku : null;
  }

  it('/api/pda/sku: 422 missing, 404 unknown, full product+relations vs direct DB', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/api/pda/sku', headers: KEY() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ message: 'sku is required' });
    res = await app.inject({ method: 'GET', url: '/api/pda/sku?sku=NOPE404', headers: KEY() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'product not found' });

    res = await app.inject({ method: 'GET', url: '/api/pda/sku?sku=A004SV', headers: KEY() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const product = (await db.selectFrom('os_products').selectAll().where('sku', '=', 'A004SV').executeTakeFirst())!;
    for (const [k, v] of Object.entries(product)) expect(body[k]).toEqual(v);
    expect(body.type).toBe('A');
    expect(body.sku_num).toBe('004SV');
    const locs = await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', product.id).execute();
    expect(body.locations).toEqual(locs);
    const imgs = await db.selectFrom('os_product_images').selectAll().where('product_id', '=', String(product.id)).execute();
    expect(body.images).toEqual(imgs);
    expect((body.images as Record<string, unknown>[]).map((i) => typeof i.product_id)).toEqual(imgs.map(() => 'string')); // varchar column
    await app.close();
  });

  it('transactions endpoints: 422 missing, totals vs direct SQL, paging clamps', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/api/pda/transactions/sku', headers: KEY() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ message: 'sku is required' });
    res = await app.inject({ method: 'GET', url: '/api/pda/transactions/location', headers: KEY() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ message: 'location is required' });

    res = await app.inject({ method: 'GET', url: '/api/pda/transactions/sku?sku=A004SV', headers: KEY() });
    expect(res.statusCode).toBe(200);
    let body = res.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    const total = (
      await db.selectFrom('os_pda_inventory_transactions').select(['id']).where('sku', '=', 'A004SV').execute()
    ).length;
    expect(body.total).toBe(total);
    expect(body.transactions).toHaveLength(total);
    const ids = body.transactions.map((t: { id: number }) => t.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids); // id desc

    // pageSize clamp: 500 -> 200, page 0 -> 1
    res = await app.inject({ method: 'GET', url: '/api/pda/transactions/sku?sku=A004SV&pageSize=500&page=0', headers: KEY() });
    body = res.json();
    expect(body.pageSize).toBe(200);
    expect(body.page).toBe(1);

    res = await app.inject({ method: 'GET', url: '/api/pda/transactions/location?location=B19-M-L2', headers: KEY() });
    body = res.json();
    const txTotal = (
      await db
        .selectFrom('os_pda_inventory_transactions')
        .select(['id'])
        .where(sql`UPPER(TRIM(os_pda_inventory_transactions.location))`, '=', 'B19-M-L2')
        .execute()
    ).length;
    expect(body.total).toBe(txTotal);
    expect(txTotal).toBeGreaterThan(0);
    const dbRow = await db
      .selectFrom('os_pda_inventory_transactions')
      .selectAll()
      .where(sql`UPPER(TRIM(os_pda_inventory_transactions.location))`, '=', 'B19-M-L2')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    expect(body.transactions[0]).toEqual(dbRow);
    await app.close();
  });

  it('/api/pda/receiving: 200 with DATE padding, status filter, 422 bad status', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/api/pda/receiving', headers: KEY() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const total = (await db.selectFrom('os_pda_receiving_lines').select(['id']).execute()).length;
    expect(body.total).toBe(total);
    expect(body.pageSize).toBe(50);
    for (const line of body.lines as Record<string, unknown>[]) {
      expect(String(line.received_date)).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
    }
    res = await app.inject({ method: 'GET', url: '/api/pda/receiving?status=received', headers: KEY() });
    expect(res.json().total).toBe(
      (await db.selectFrom('os_pda_receiving_lines').select(['id']).where('status', '=', 'received').execute()).length,
    );
    res = await app.inject({ method: 'GET', url: '/api/pda/receiving?status=bad', headers: KEY() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ message: 'status must be one of: received, putaway, void' });
    await app.close();
  });

  it('inventory qty/link lifecycle on a temp product (all rows cleaned up)', async () => {
    const now = nowDb();
    const ins = await db
      .insertInto('os_products')
      .values({ sku: TEMP_SKU, name: 't24 test', created_at: now as unknown as Date, updated_at: now as unknown as Date } as never)
      .executeTakeFirst();
    const pid = Number(ins.insertId);
    const app = await buildApp();
    const post = (url: string, body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: { ...KEY(), 'content-type': 'application/json' }, payload: body });

    // validation + 404
    let res = await post('/api/pda/inventory/qty', { location: 'T24-A', qty: 1 });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ message: 'sku is required' });
    res = await post('/api/pda/inventory/qty', { sku: TEMP_SKU, qty: 1 });
    expect(res.json()).toEqual({ message: 'location is required' });
    res = await post('/api/pda/inventory/qty', { sku: TEMP_SKU, location: 'T24-A' });
    expect(res.json()).toEqual({ message: 'qty is required' });
    res = await post('/api/pda/inventory/qty', { sku: 'NOPE404', location: 'T24-A', qty: 1 });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'sku not found' });

    // create row
    res = await post('/api/pda/inventory/qty', { sku: TEMP_SKU, location: 't24-a', qty: 5, packing: 2 });
    expect(res.statusCode).toBe(200);
    let row = res.json();
    expect(row.product_id).toBe(pid);
    expect(row.location).toBe('T24-A');
    expect(row.qty).toBe(5);
    expect(row.packing).toBe(2);
    const rowId = Number(row.id);

    // update the same row (case-insensitive match), qty int-cast like PHP
    res = await post('/api/pda/inventory/qty', { sku: TEMP_SKU, location: 'T24-A', qty: '3.9' });
    expect(res.json().id).toBe(rowId);
    expect(res.json().qty).toBe(3);

    // link: create, then 409 on repeat
    res = await post('/api/pda/inventory/link', { sku: TEMP_SKU, location: 'T24-B', qty: 7, carton: 1, packing: 2 });
    expect(res.statusCode).toBe(201);
    const bId = Number(res.json().id);
    res = await post('/api/pda/inventory/link', { sku: TEMP_SKU, location: 'T24-B', qty: 7 });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('sku-location already exists');
    expect(res.json().row.id).toBe(bId);

    // merge: 'T24-b ' duplicate collapses onto the lowest id
    await db
      .insertInto('os_product_locations')
      .values({ product_id: pid, location: 'T24-b', qty: 2, created_at: now as unknown as Date, updated_at: now as unknown as Date } as never)
      .execute();
    res = await post('/api/pda/inventory/qty', { sku: TEMP_SKU, location: 'T24-B', qty: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(bId);
    expect(res.json().qty).toBe(0); // 7 + 2 merged, then set to 0
    const dup = await db.selectFrom('os_product_locations').select(['id']).where('product_id', '=', pid).execute();
    expect(dup).toHaveLength(2);

    // remove
    let del = await app.inject({ method: 'DELETE', url: '/api/pda/inventory/link', headers: KEY(), query: { sku: TEMP_SKU, location: 'T24-B' } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ message: 'removed' });
    del = await app.inject({ method: 'DELETE', url: '/api/pda/inventory/link', headers: KEY(), query: { sku: TEMP_SKU, location: 'T24-B' } });
    expect(del.statusCode).toBe(404);
    expect(del.json()).toEqual({ message: 'sku-location not found' });

    // transactions logged for this sku
    res = await app.inject({ method: 'GET', url: `/api/pda/transactions/sku?sku=${TEMP_SKU}`, headers: KEY() });
    const tx = res.json();
    expect(tx.total).toBe(5);
    const types = tx.transactions.map((t: { transaction_type: string }) => t.transaction_type);
    expect(types).toEqual(['remove_sku_location', 'qty_update', 'add_sku_location', 'qty_update', 'qty_update']);
    expect(tx.transactions[0].meta).toBe('{"source":"pda"}');
    expect(tx.transactions[0].user_id).toBe(TOKEN_USER_ID);

    await app.close();
    // manual cleanup (afterAll covers sku-level rows, drop the location rows explicitly too)
    await db.deleteFrom('os_product_locations').where('product_id', '=', pid).execute();
    await db.deleteFrom('os_products').where('id', '=', pid).execute();
    await db.deleteFrom('os_pda_inventory_transactions').where('sku', '=', TEMP_SKU).execute();
  });

  it('receiving store/update lifecycle on a temp product (cleaned up)', async () => {
    const now = nowDb();
    const ins = await db
      .insertInto('os_products')
      .values({ sku: TEMP_SKU, name: 't24 test', created_at: now as unknown as Date, updated_at: now as unknown as Date } as never)
      .executeTakeFirst();
    const app = await buildApp();
    const post = (url: string, body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: { ...KEY(), 'content-type': 'application/json' }, payload: body });
    const today = nowDb().slice(0, 10);

    // validation (Laravel messages, first failing rule per field)
    let res = await post('/api/pda/receiving', { qty: 1 });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ message: 'The sku field is required.', errors: { sku: ['The sku field is required.'] } });
    res = await post('/api/pda/receiving', { sku: TEMP_SKU, qty: '1.5' });
    expect(res.json().errors.qty).toEqual(['The qty field must be an integer.']);
    res = await post('/api/pda/receiving', { sku: TEMP_SKU, qty: -1 });
    expect(res.json().errors.qty).toEqual(['The qty field must be at least 0.']);
    res = await post('/api/pda/receiving', { sku: TEMP_SKU, qty: 1, status: 'x' });
    expect(res.json().errors.status).toEqual(['The selected status is invalid.']);
    res = await post('/api/pda/receiving', { sku: TEMP_SKU, qty: 1, received_date: '' });
    expect(res.json().errors.received_date).toEqual(['The received_date field must be a valid date.']);

    // store: defaults (status received, received_date today, put_away null)
    res = await post('/api/pda/receiving', { sku: TEMP_SKU, qty: 4, carton: 'C1', per_carton: 2, perCarton: '2' });
    expect(res.statusCode).toBe(201);
    const line = res.json();
    expect(line.sku).toBe(TEMP_SKU);
    expect(line.qty).toBe(4);
    expect(line.status).toBe('received');
    expect(line.received_date).toBe(`${today} 00:00:00`);
    expect(line.put_away_date).toBeNull();
    expect(line.per_carton).toBe('2');
    const id = Number(line.id);

    // PHP quirk: per_carton dropped when only perCarton is sent
    res = await post('/api/pda/receiving', { sku: TEMP_SKU, qty: 1, perCarton: '9' });
    expect(res.json().per_carton).toBeNull();
    const quirkId = Number(res.json().id);

    // store with status putaway -> put_away_date defaults to today
    res = await post('/api/pda/receiving', { sku: TEMP_SKU, qty: 1, status: 'putaway' });
    expect(res.json().put_away_date).toBe(`${today} 00:00:00`);
    const putId = Number(res.json().id);

    // update: 404 unknown id, 422 no fields
    let patch = await app.inject({ method: 'PATCH', url: '/api/pda/receiving/999999', headers: { ...KEY(), 'content-type': 'application/json' }, payload: { qty: 1 } });
    expect(patch.statusCode).toBe(404);
    expect(patch.json()).toEqual({ message: 'receiving line not found' });
    patch = await app.inject({ method: 'PATCH', url: `/api/pda/receiving/${id}`, headers: { ...KEY(), 'content-type': 'application/json' }, payload: {} });
    expect(patch.statusCode).toBe(422);
    expect(patch.json()).toEqual({ message: 'provide status, qty, and/or put_away_date' });
    patch = await app.inject({ method: 'PATCH', url: `/api/pda/receiving/${id}`, headers: { ...KEY(), 'content-type': 'application/json' }, payload: { status: 'bogus' } });
    expect(patch.statusCode).toBe(422);
    expect(patch.json().errors.status).toEqual(['The selected status is invalid.']);

    // update qty + status -> putaway fills put_away_date; meta has before/after snapshots
    patch = await app.inject({ method: 'PATCH', url: `/api/pda/receiving/${id}`, headers: { ...KEY(), 'content-type': 'application/json' }, payload: { qty: 9, status: 'putaway' } });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json();
    expect(updated.qty).toBe(9);
    expect(updated.status).toBe('putaway');
    expect(updated.put_away_date).toBe(`${today} 00:00:00`);
    const tx = await db
      .selectFrom('os_pda_inventory_transactions')
      .selectAll()
      .where('sku', '=', TEMP_SKU)
      .where('transaction_type', '=', 'receiving_update')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    expect(tx).not.toBeNull();
    const meta = JSON.parse(tx!.meta as string);
    expect(meta.source).toBe('pda');
    expect(meta.receiving_line_id).toBe(id);
    expect(meta.before.qty).toBe(4);
    expect(meta.after.qty).toBe(9);
    expect(meta.before.received_date).toBe(today);
    expect(tx!.product_id).toBe(Number(ins.insertId)); // product existed by sku

    await app.close();
    await db.deleteFrom('os_product_locations').where('product_id', '=', Number(ins.insertId)).execute();
    await db.deleteFrom('os_products').where('id', '=', Number(ins.insertId)).execute();
    await db.deleteFrom('os_pda_receiving_lines').where('id', 'in', [id, quirkId, putId]).execute();
    await db.deleteFrom('os_pda_inventory_transactions').where('sku', '=', TEMP_SKU).execute();
  });
});
