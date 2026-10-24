// T25b: InventoryController transfers (web.php:371-376) + consolidation
// (web.php:461-462). All mutating tests use temp rows (T25B prefix) and clean up.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerInventoryRoutes } from '../src/modules/inventory/routes.js';
import { registerViewPlugins } from '../src/view.js';
import { recommend } from '../src/lib/warehouseLocation.js';

type Row = { id: number };

async function userWithoutAllowedRole(): Promise<Row | null> {
  const rows = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_users.id as uid', 'os_roles.name as role'])
    .execute();
  const byUser = new Map<number, Set<string>>();
  for (const r of rows) {
    const s = byUser.get(r.uid) ?? new Set<string>();
    s.add(r.role);
    byUser.set(r.uid, s);
  }
  for (const [id, rs] of byUser) if (![...rs].some((x) => ['admin', 'user', 'remote'].includes(x))) return { id };
  return null;
}

async function userWithRole(roles: string[]): Promise<Row | null> {
  return (
    (await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id'])
      .where('os_roles.name', 'in', roles)
      .executeTakeFirst()) ?? null);
}

// One app for the whole file (router shims are module-global, like T25a);
// the session user is swapped per test through `currentUser`.
let currentUser: Row | null = null;
const app = (() => {
  const a = Fastify();
  void a.register(formbody);
  void a.register(registerHttpHelpers);
  void registerViewPlugins(a);
  registerInventoryRoutes(a);
  a.addHook('preHandler', async (req) => {
    if (currentUser) (req.session as Record<string, unknown>)['user_id'] = currentUser.id;
  });
  return a;
})();

async function tempInventoryTransfer(partial: Record<string, unknown> = {}): Promise<number> {
  const res = await db
    .insertInto('os_inventory_transfer')
    .values({
      sku: 'T25B-TRF',
      from_location: 'AI',
      to_location: 'China',
      qty: 1,
      status: 'Pending',
      expected_date: '2024-01-01',
      ...partial,
    } as never)
    .executeTakeFirst();
  return Number(res?.insertId);
}

async function tempInventory(sku: string, location: string, qty: number): Promise<number> {
  const res = await db
    .insertInto('os_inventory')
    .values({
      sku,
      name: 'T25B temp',
      location,
      qty,
      created_at: '2024-01-01 00:00:00',
      updated_at: '2024-01-01 00:00:00',
    } as never)
    .executeTakeFirst();
  return Number(res?.insertId);
}

async function tempProduct(partial: Record<string, unknown> = {}): Promise<number> {
  const res = await db
    .insertInto('os_products')
    .values({
      sku: 'T25B-PROD',
      name: 'T25B temp product',
      status: '0',
      created_at: '2024-01-01 00:00:00',
      updated_at: '2024-01-01 00:00:00',
      ...partial,
    } as never)
    .executeTakeFirst();
  return Number(res?.insertId);
}

async function tempProductLocation(productId: number, location: string, qty: number): Promise<number> {
  const res = await db
    .insertInto('os_product_locations')
    .values({
      product_id: productId,
      location,
      qty,
      created_at: '2024-01-01 00:00:00',
      updated_at: '2024-01-01 00:00:00',
    } as never)
    .executeTakeFirst();
  return Number(res?.insertId);
}

async function leftover(): Promise<number> {
  const [t, i, p, l] = await Promise.all([
    db.selectFrom('os_inventory_transfer').select('id').where('sku', 'like', 'T25B-%').execute(),
    db.selectFrom('os_inventory').select('id').where('sku', 'like', 'T25B-%').execute(),
    db.selectFrom('os_products').select('id').where('sku', 'like', 'T25B-%').execute(),
    // product locations of any leftover temp products.
    db
      .selectFrom('os_product_locations')
      .select('os_product_locations.id')
      .innerJoin('os_products', 'os_products.id', 'os_product_locations.product_id')
      .where('os_products.sku', 'like', 'T25B-%')
      .execute(),
  ]);
  return t.length + i.length + p.length + l.length;
}

describe('T25b transfers + consolidation (fastify inject, live DB)', () => {
  beforeAll(async () => {
    // start clean even if a prior run aborted mid-test
    await db.deleteFrom('os_inventory_transfer').where('sku', 'like', 'T25B-%').execute();
    await db.deleteFrom('os_inventory').where('sku', 'like', 'T25B-%').execute();
    const prods = await db.selectFrom('os_products').select('id').where('sku', 'like', 'T25B-%').execute();
    if (prods.length > 0) {
      const ids = prods.map((p) => p.id);
      await db.deleteFrom('os_product_locations').where('product_id', 'in', ids).execute();
      await db.deleteFrom('os_products').where('id', 'in', ids).execute();
    }
  });

  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = await app.inject({ method: 'GET', url: '/inventory.transferdata?location=AI' });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers['location']).toBe('http://localhost:80/login');

    currentUser = await userWithoutAllowedRole();
    if (currentUser) {
      const denied = await app.inject({ method: 'GET', url: '/inventory.transferdata?location=AI' });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).toBe('No Access.');
    }
    currentUser = null;
  });

  it('/inventory.transferdata: location match + currentItem sku filter (datatables data)', async () => {
    currentUser = await userWithRole(['admin', 'user', 'remote']);
    if (!currentUser) throw new Error('no admin/user/remote user in DB');
    const trf = await tempInventoryTransfer({ sku: 'T25B-DT', to_location: 'China', from_location: 'AI' });
    try {
      // No currentItem -> the Debugbar::info($request->currentItem['sku'])
      // line warns on null['sku'] -> 500 (verified live on :6999).
      const noCur = await app.inject({ method: 'GET', url: '/inventory.transferdata?location=China' });
      expect(noCur.statusCode).toBe(500);

      const res = await app.inject({
        method: 'POST',
        url: '/inventory.transferdata?location=China',
        payload: { currentItem: { sku: 'SCA001' } },
      });
      expect(res.statusCode).toBe(200);

      const noMatch = await app.inject({
        method: 'POST',
        url: '/inventory.transferdata?location=Nowhere',
        payload: { currentItem: { sku: 'T25B-DT' } },
      });
      expect(noMatch.statusCode).toBe(200);
      expect((noMatch.json() as Record<string, unknown>[])).toHaveLength(0);

      const bySku = await app.inject({
        method: 'POST',
        url: '/inventory.transferdata?location=AI',
        payload: { currentItem: { sku: 'T25B-DT' } },
      });
      expect(bySku.statusCode).toBe(200);
      const skuRows = bySku.json() as Record<string, unknown>[];
      expect(skuRows).toHaveLength(1);
      expect(skuRows[0]['id']).toBe(trf);

      // currentItem present but not an object -> PHP warning -> 500.
      const bad = await app.inject({
        method: 'POST',
        url: '/inventory.transferdata?location=AI',
        payload: { currentItem: 'x' },
      });
      expect(bad.statusCode).toBe(500);
    } finally {
      await db.deleteFrom('os_inventory_transfer').where('id', '=', trf).execute();
    }
  });

  it('/inventory.createTransfer: insert + recalculateInventory side effects', async () => {
    currentUser = await userWithRole(['admin', 'user', 'remote']);
    if (!currentUser) throw new Error('no admin/user/remote user in DB');
    const fromId = await tempInventory('T25B-INV', 'T25BF', 9);
    const toId = await tempInventory('T25B-INV', 'T25BT', 9);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/inventory.createTransfer',
        payload: {
          sku: 'T25B-INV',
          from_location: 'T25BF',
          to_location: 'T25BT',
          qty: 5,
          received: 3,
          status: 'Completed',
          expected_date: '2024-01-01',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body['from_location']).toBe('T25BF');
      expect(body['to_location']).toBe('T25BT');
      expect(Number(body['id'])).toBeGreaterThan(0);
      expect(typeof body['created_at']).toBe('string');

      const row = await db.selectFrom('os_inventory_transfer').selectAll().where('id', '=', Number(body['id'])).executeTakeFirst();
      expect(row?.sku).toBe('T25B-INV');

      // recalculateInventory quirk: from_inv.qty = received-into-from - qty-out-of-from
      // = 0 - 5 = -5; to_inv.qty = received-into-to = 3; pending_qty = SUM(pending) = null.
      const fromInv = await db.selectFrom('os_inventory').select(['qty', 'pending_qty']).where('id', '=', fromId).executeTakeFirst();
      const toInv = await db.selectFrom('os_inventory').select(['qty', 'pending_qty']).where('id', '=', toId).executeTakeFirst();
      expect(fromInv?.qty).toBe(-5);
      expect(toInv?.qty).toBe(3);
      expect(toInv?.pending_qty).toBeNull();

      // _method form spoofing (POST + _method=PUT reaches the PUT route).
      const spoof = await app.inject({
        method: 'POST',
        url: '/inventory.createTransfer',
        payload: { _method: 'PUT', sku: 'T25B-INV', from_location: 'T25BF', to_location: 'T25BT', qty: 1, status: 'Pending', expected_date: '2024-01-01' },
      });
      expect(spoof.statusCode).toBe(200);
      expect(Number((spoof.json() as Record<string, unknown>)['id'])).toBeGreaterThan(0);

      // Missing NOT NULL column (status): the old app's connection is non-strict, so MySQL stores '' and the request succeeds.
      const missing = await app.inject({ method: 'PUT', url: '/inventory.createTransfer', payload: { sku: 'T25B-INV', from_location: 'T25BF', to_location: 'T25BT', qty: 1 } });
      expect(missing.statusCode).toBe(200);
    } finally {
      await db.deleteFrom('os_inventory_transfer').where('sku', '=', 'T25B-INV').execute();
      await db.deleteFrom('os_inventory').where('sku', '=', 'T25B-INV').execute();
    }
  });

  it('/inventory.updateTransfer: update, from==to 500, unknown id empty 200', async () => {
    currentUser = await userWithRole(['admin', 'user', 'remote']);
    if (!currentUser) throw new Error('no admin/user/remote user in DB');
    const trf = await tempInventoryTransfer({ sku: 'T25B-UPD' });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/inventory.updateTransfer',
        payload: { id: trf, _method: 'POST', status: 'OnRoute', qty: 7, sku: 'T25B-UPD', from_location: 'AI', to_location: 'China' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body['status']).toBe('OnRoute');
      expect(Number(body['qty'])).toBe(7);
      const row = await db.selectFrom('os_inventory_transfer').select(['status', 'qty']).where('id', '=', trf).executeTakeFirst();
      expect(row?.status).toBe('OnRoute');
      expect(row?.qty).toBe(7);

      // from == to -> 500 with the exact message (checked after both assignments).
      const same = await app.inject({
        method: 'POST',
        url: '/inventory.updateTransfer',
        payload: { id: trf, to_location: 'AI', sku: 'T25B-UPD', from_location: 'AI', qty: 1 },
      });
      expect(same.statusCode).toBe(500);
      expect(same.body).toBe('from and to locations cannot be the same');

      const unknown = await app.inject({ method: 'POST', url: '/inventory.updateTransfer', payload: { id: 99999999 } });
      expect(unknown.statusCode).toBe(200);
      expect(unknown.body).toBe('');
    } finally {
      await db.deleteFrom('os_inventory_transfer').where('id', '=', trf).execute();
    }
  });

  it('/inventory.deleteTransfer: deletes the row, empty 200; /inventory.upload: empty 200', async () => {
    currentUser = await userWithRole(['admin', 'user', 'remote']);
    if (!currentUser) throw new Error('no admin/user/remote user in DB');
    const trf = await tempInventoryTransfer({ sku: 'T25B-DEL' });
    const del = await app.inject({
      method: 'POST',
      url: '/inventory.deleteTransfer',
      payload: { _method: 'DELETE', id: trf, sku: 'T25B-DEL', from_location: 'AI', to_location: 'China' },
    });
    expect(del.statusCode).toBe(200);
    expect(del.body).toBe('');
    expect(await db.selectFrom("os_inventory_transfer").select("id").where("id", "=", trf).executeTakeFirst()).toBeFalsy();

    // delete of a missing id: find -> null, recalc runs, empty 200.
    const missing = await app.inject({ method: 'POST', url: '/inventory.deleteTransfer', payload: { _method: 'DELETE', id: 99999999 } });
    expect(missing.statusCode).toBe(200);
    expect(missing.body).toBe('');

    // uploadTransfer: find + empty if-block + return null -> empty 200, no writes.
    const up = await app.inject({ method: 'POST', url: '/inventory.upload', payload: { id: trf } });
    expect(up.statusCode).toBe(200);
    expect(up.body).toBe('');
  });

  it('/api/inventory/consolidation: scattered product -> item with recommendation; any filter 500s (old-app Laravel 5.4 bug)', async () => {
    currentUser = await userWithRole(['admin', 'user', 'remote']);
    if (!currentUser) throw new Error('no admin/user/remote user in DB');
    const pid = await tempProduct({ sku: 'T25B-CONS' });
    const locA = await tempProductLocation(pid, 'T25B-L1', 4);
    const locB = await tempProductLocation(pid, 'T25B-L99', 2);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/inventory/consolidation' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { total: number; items: Record<string, unknown>[] };
      const mine = body.items.filter((i) => i['sku'] === 'T25B-CONS');
      expect(mine).toHaveLength(1);
      const item = mine[0];
      expect(item['product_id']).toBe(pid);
      const rec = recommend([
        { id: locA, location: 'T25B-L1', qty: 4, packing: null, carton: null },
        { id: locB, location: 'T25B-L99', qty: 2, packing: null, carton: null },
      ]);
      // Cross-check the recommendation logic: target is the max-qty bin.
      expect(item['suggested_target']).toBe('T25B-L1');
      expect(item['suggested_moves']).toEqual([{ from: 'T25B-L99', to: 'T25B-L1', qty: 2, reason: 'scattered from T25B-L99' }]);
      expect(item['clusters']).toEqual(rec!.clusters);

      // Any non-empty filter 500s in the old app (Laravel 5.4 orWhereHas
      // framework bug — see route comment); ported faithfully.
      const filtered = await app.inject({ method: 'GET', url: '/api/inventory/consolidation?filter=T25B-CONS' });
      expect(filtered.statusCode).toBe(500);
      const none = await app.inject({ method: 'GET', url: '/api/inventory/consolidation?filter=T25B-NOMATCH' });
      expect(none.statusCode).toBe(500);
      // Empty filter param = no filter.
      const emptyFilter = await app.inject({ method: 'GET', url: '/api/inventory/consolidation?filter=' });
      expect(emptyFilter.statusCode).toBe(200);
    } finally {
      await db.deleteFrom('os_product_locations').where('product_id', '=', pid).execute();
      await db.deleteFrom('os_products').where('id', '=', pid).execute();
    }
  });

  it('/api/inventory/consolidation/move: legacy + multi-move, 422/404 validation, rollback on failure', async () => {
    currentUser = await userWithRole(['admin', 'user', 'remote']);
    if (!currentUser) throw new Error('no admin/user/remote user in DB');
    const pid = await tempProduct({ sku: 'T25B-MOVE' });
    const srcA = await tempProductLocation(pid, 'O1B1L1', 10);
    const srcB = await tempProductLocation(pid, 'O5B9L9', 2);
    try {
      // 422s.
      const noSku = await app.inject({ method: 'POST', url: '/api/inventory/consolidation/move', payload: { from_location: 'O1B1L1', qty: 1 } });
      expect(noSku.statusCode).toBe(422);
      expect(noSku.json()).toEqual({ message: 'sku is required' });
      const bad = await app.inject({
        method: 'POST',
        url: '/api/inventory/consolidation/move',
        payload: { sku: 'T25B-MOVE', moves: [{ from_location: 'O1B1L1', to_location: 'o1b1l1', qty: 1 }] },
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toEqual({ message: 'O1B1L1 destination must differ from source' });
      const zero = await app.inject({
        method: 'POST',
        url: '/api/inventory/consolidation/move',
        payload: { sku: 'T25B-MOVE', moves: [{ from_location: 'O1B1L1', to_location: 'O2B2L2', qty: 0 }] },
      });
      expect(zero.statusCode).toBe(422);
      expect(zero.json()).toEqual({ message: 'qty must be greater than 0' });
      const notFound = await app.inject({
        method: 'POST',
        url: '/api/inventory/consolidation/move',
        payload: { sku: 'T25B-MOVE', moves: [{ from_location: 'O9B9L9', to_location: 'O2B2L2', qty: 1 }] },
      });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json()).toEqual({ message: 'source location not found: O9B9L9' });
      const noProduct = await app.inject({
        method: 'POST',
        url: '/api/inventory/consolidation/move',
        payload: { sku: 'T25B-NOPROD', moves: [{ from_location: 'O1B1L1', to_location: 'O2B2L2', qty: 1 }] },
      });
      expect(noProduct.statusCode).toBe(404);
      expect(noProduct.json()).toEqual({ message: 'sku not found' });

      // Legacy single-move body (lowercase locations are upper-cased).
      const legacy = await app.inject({
        method: 'POST',
        url: '/api/inventory/consolidation/move',
        payload: { sku: 'T25B-MOVE', from_location: 'o1b1l1', to_location: 'o5b9l9', qty: 4 },
      });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).toEqual({
        success: true,
        sku: 'T25B-MOVE',
        moves: [{ from_location: 'O1B1L1', to_location: 'O5B9L9', qty: 4 }],
      });
      const a = await db.selectFrom('os_product_locations').select(['qty', 'countdate']).where('id', '=', srcA).executeTakeFirst();
      const b = await db.selectFrom('os_product_locations').select(['qty', 'countdate', 'location']).where('id', '=', srcB).executeTakeFirst();
      expect(a?.qty).toBe(6);
      expect(b?.qty).toBe(6);
      expect(b?.location).toBe('O5B9L9');
      expect(typeof b?.countdate).toBe('string');

      // Multi-move: the second move fails (not enough qty) -> rollback the first.
      const multi = await app.inject({
        method: 'POST',
        url: '/api/inventory/consolidation/move',
        payload: {
          sku: 'T25B-MOVE',
          moves: [
            { from_location: 'O1B1L1', to_location: 'O5B9L9', qty: 2 },
            { from_location: 'O5B9L9', to_location: 'O1B1L1', qty: 100 },
          ],
        },
      });
      expect(multi.statusCode).toBe(422);
      expect(multi.json()).toEqual({ message: 'O5B9L9 does not have enough qty' });
      const a2 = await db.selectFrom('os_product_locations').select('qty').where('id', '=', srcA).executeTakeFirst();
      const b2 = await db.selectFrom('os_product_locations').select('qty').where('id', '=', srcB).executeTakeFirst();
      expect(a2?.qty).toBe(6); // rolled back
      expect(b2?.qty).toBe(6);

      // Consume the source fully -> row deleted (ensureDefaultStillStocked is a
      // no-op: the temp product has no default_location).
      const drain = await app.inject({
        method: 'POST',
        url: '/api/inventory/consolidation/move',
        payload: { sku: 'T25B-MOVE', moves: [{ from_location: 'O1B1L1', to_location: 'O5B9L9', qty: 6 }] },
      });
      expect(drain.statusCode).toBe(200);
      expect(await db.selectFrom('os_product_locations').select('id').where('id', '=', srcA).executeTakeFirst()).toBeUndefined();
      const b3 = await db.selectFrom('os_product_locations').select('qty').where('id', '=', srcB).executeTakeFirst();
      expect(b3?.qty).toBe(12);
    } finally {
      await db.deleteFrom('os_product_locations').where('product_id', '=', pid).execute();
      await db.deleteFrom('os_products').where('id', '=', pid).execute();
    }
  });

  it('no T25B temp rows left behind', async () => {
    expect(await leftover()).toBe(0);
  });
});
