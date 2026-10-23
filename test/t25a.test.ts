// T25a: InventoryController — /inventory, /inv, /inventory.data,
// /inventory.create|update|delete, /inventory.response (DatatablesEditor),
// /inventory.quickUpdate, /inventory.findLocations.
// All mutating tests use temp rows (T25A prefix) and clean up.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerInventoryRoutes } from '../src/modules/inventory/routes.js';
import { registerViewPlugins } from '../src/view.js';

type Row = { id: number };

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

async function userWithoutRole(): Promise<Row | null> {
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

// One app for the whole file: the router's _method spoof shims are a module
// global, so a fresh app per test would only get the shims on the first one.
// The session user is swapped per test through `currentUser`.
let currentUser: Row | null = null;
const sharedApp = (() => {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerInventoryRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (currentUser) (req.session as Record<string, unknown>)['user_id'] = currentUser.id;
  });
  return app;
})();

function asUser(user: Row | null): typeof sharedApp {
  currentUser = user;
  return sharedApp;
}

// ---------------------------------------------------------------- temp data

async function tempInventory(partial: Record<string, unknown> = {}): Promise<number> {
  const res = await db
    .insertInto('os_inventory')
    .values({
      sku: 'T25A-TMP',
      name: 'T25A temp',
      location: 'AI',
      qty: 1,
      created_at: '2024-01-01 00:00:00',
      updated_at: '2024-01-01 00:00:00',
      ...partial,
    } as never)
    .executeTakeFirst();
  return Number(res?.insertId);
}

async function deleteTempInventory(id: number): Promise<void> {
  await db.deleteFrom('os_inventory').where('id', '=', id).execute();
}

async function tempProduct(partial: Record<string, unknown> = {}): Promise<number> {
  const res = await db
    .insertInto('os_products')
    .values({
      sku: 'T25A-PROD',
      name: 'T25A temp product',
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

async function deleteTempProductLocation(id: number): Promise<void> {
  await db.deleteFrom('os_product_locations').where('id', '=', id).execute();
}

async function deleteTempProduct(id: number): Promise<void> {
  await db.deleteFrom('os_products').where('id', '=', id).execute();
}

describe('T25a inventory (fastify inject, live DB)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = asUser(null);
    const out = await anon.inject({ method: 'GET', url: '/inventory' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
  
    const denied = await userWithoutRole();
    if (denied) {
      const app = asUser(denied);
      const res = await app.inject({ method: 'GET', url: '/inventory' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('No Access.');
    }
  });

  it('/inventory and /inv render (200) with the /inv named-route URLs and ?location echo', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = asUser(user);

    for (const url of ['/inventory', '/inv']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Inventory');
      // Both routes are named 'inventory'; Laravel last-registration wins -> /inv.
      expect(res.body).toContain('/inv?location=AI');
      expect(res.body).not.toContain('/inventory?location=AI');
      expect(res.body).toContain("var currentLocation = 'AI';");
    }
    const china = await app.inject({ method: 'GET', url: '/inv?location=China' });
    expect(china.statusCode).toBe(200);
    expect(china.body).toContain("var currentLocation = 'China';");
    // The two views differ: only inv.njk has the image dialog + loadRow guard.
    const inv = await app.inject({ method: 'GET', url: '/inv' });
    expect(inv.body).toContain('id="imagedialog"');
    expect(inv.body).toContain('loadRow = true');
  });

  it('/inventory.data: absent location/filter -> []; real data + yajra search/order', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = asUser(user);

    // No filter param -> PHP $request->filter["name"] on null is a warning
    // that Laravel turns into an ErrorException -> 500 (reproduced).
    const none = await app.inject({ method: 'GET', url: '/inventory.data' });
    expect(none.statusCode).toBe(500);

    // Plain location filter, cross-checked against direct SQL.
    const direct = await db
      .selectFrom('os_inventory')
      .selectAll()
      .where('location', '=', 'AI')
      .orderBy('qty', 'desc')
      .execute();
    // The nested columns/order arrays are exercised via the JSON body (the
    // route is Route::any); fastify query parsing does not expand bracket
    // notation, so a pure GET query string can't carry them.
    const all = await app.inject({
      method: 'POST',
      url: '/inventory.data?location=AI',
      payload: {
        columns: [
          { name: 'id', searchable: 'true', orderable: 'true' },
          { name: 'name', searchable: 'true', orderable: 'true' },
          { name: 'color', searchable: 'true', orderable: 'true' },
          { name: 'qty', searchable: 'true', orderable: 'true' },
        ],
        order: [{ column: 3, dir: 'desc' }],
        filter: { name: '', color: '', vendor_sku: '', sku: '' },
      },
    });
    expect(all.statusCode).toBe(200);
    const rows = all.json() as Record<string, unknown>[];
    expect(rows.length).toBe(direct.length);
    // qty has duplicates (ties) -> MySQL tie order is nondeterministic;
    // compare the qty sequence and the id set instead of the raw id order.
    expect(rows.map((r) => Number(r['qty']))).toEqual(direct.map((r) => r.qty));
    expect(rows.map((r) => r['id']).sort((a, b) => Number(a) - Number(b))).toEqual(
      direct.map((r) => r.id).sort((a, b) => a - b),
    );

    // Column filter via the PHP-specific `filter[...]` param — the value is
    // used RAW (no % wildcards, `name LIKE 'x'`). The nested object is sent
    // in the body (fastify query parsing does not expand bracket notation).
    const sample = await db
      .selectFrom('os_inventory')
      .select('name')
      .where('location', '=', 'AI')
      .where('name', 'is not', null)
      .executeTakeFirst();
    if (sample?.name) {
      const filtered = await db
        .selectFrom('os_inventory')
        .select('id')
        .where('location', '=', 'AI')
        .where('name', 'like', sample.name)
        .execute();
      const viaFilter = await app.inject({
        method: 'POST',
        url: '/inventory.data',
        payload: { location: 'AI', filter: { name: sample.name, color: '', vendor_sku: '', sku: '' } },
      });
      expect(viaFilter.statusCode).toBe(200);
      expect((viaFilter.json() as Record<string, unknown>[]).length).toBe(filtered.length);

      // A value that matches nothing raw -> LIKE 'x' narrows to 0 (vs 39 unfiltered).
      const noMatch = await app.inject({
        method: 'POST',
        url: '/inventory.data',
        payload: { location: 'AI', filter: { name: 'Purple', color: '', vendor_sku: '', sku: '' } },
      });
      expect((noMatch.json() as unknown[]).length).toBe(0);

      // filter present but a key missing -> PHP "Undefined array key" notice
      // -> 500 (reproduced).
      const partial = await app.inject({
        method: 'POST',
        url: '/inventory.data',
        payload: { location: 'AI', filter: { name: 'x' } },
      });
      expect(partial.statusCode).toBe(500);
    }
  });

  it('create always 500s (qty NOT NULL, controller never sets it); update -> delete lifecycle', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = asUser(user);
    let id = 0;
    try {
      // os_inventory.qty is NOT NULL with no default and the controller never
      // assigns qty -> the insert fails in the old app too (QueryException 500).
      const created = await app.inject({
        method: 'PUT',
        url: '/inventory.create',
        payload: { sku: 'T25A-C1', name: 'Temp one', location: 'T25A-NEW', qty: 3 },
      });
      expect(created.statusCode).toBe(500);
      const leaked = await db.selectFrom('os_inventory').select('id').where('sku', '=', 'T25A-C1').executeTakeFirst();
      expect(leaked).toBeFalsy();

      // _method spoofing reaches the create handler (same 500, no row).
      const spoofed = await app.inject({
        method: 'POST',
        url: '/inventory.create',
        payload: { _method: 'PUT', sku: 'T25A-C2', name: 'Temp two', location: 'T25A-NEW' },
      });
      expect(spoofed.statusCode).toBe(500);

      id = await tempInventory({ sku: 'T25A-C1', name: 'Temp one', location: 'T25A-NEW', qty: 3 });

      const updated = await app.inject({
        method: 'POST',
        url: '/inventory.update',
        payload: { id: String(id), color: 'Red' },
      });
      expect(updated.statusCode).toBe(200);
      const u = updated.json() as Record<string, unknown>;
      // find() loads all columns; the update echoes the full row.
      expect(u['id']).toBe(id);
      expect(u['sku']).toBe('T25A-C1');
      expect(u['color']).toBe('Red');
      expect(u['created_at']).toBeTruthy();
      const inDb = await db.selectFrom('os_inventory').selectAll().where('id', '=', id).executeTakeFirst();
      expect(inDb?.color).toBe('Red');

      // Unknown id -> return null -> empty 200.
      const missing = await app.inject({ method: 'POST', url: '/inventory.update', payload: { id: '99999999', sku: 'x' } });
      expect(missing.statusCode).toBe(200);
      expect(missing.body).toBe('');

      const del = await app.inject({ method: 'DELETE', url: '/inventory.delete', payload: { id: String(id) } });
      expect(del.statusCode).toBe(200);
      expect(del.body).toBe('');
      const gone = await db.selectFrom('os_inventory').select('id').where('id', '=', id).executeTakeFirst();
      expect(gone).toBeFalsy();
    } finally {
      await deleteTempInventory(id);
    }
  });

  it('/inventory.response: 500 without data; fieldErrors; edit + remove; create 500', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = asUser(user);
    const id = await tempInventory({ sku: 'T25A-DR', name: 'DR temp' });
    try {
      // Missing `data` -> PHP TypeError -> 500.
      const noData = await app.inject({ method: 'POST', url: '/inventory.response', payload: { action: 'edit' } });
      expect(noData.statusCode).toBe(500);

      // Validation failure: fieldErrors in rule order (sku, name).
      const invalid = await app.inject({
        method: 'POST',
        url: '/inventory.response',
        payload: { action: 'edit', data: { [String(id)]: {} } },
      });
      expect(invalid.statusCode).toBe(200);
      // PHP $messages->get($key) returns the message ARRAY (kept).
      expect(invalid.json()).toEqual({
        fieldErrors: [
          { name: 'sku', status: ['Please provide sku name.'] },
          { name: 'name', status: ['Please provide name.'] },
        ],
      });

      // Edit: find() is the STATIC (unscoped) Inventory::find.
      const edited = await app.inject({
        method: 'POST',
        url: '/inventory.response',
        payload: { action: 'edit', data: { [String(id)]: { sku: 'T25A-DR2', name: 'DR temp 2' } } },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toEqual({ data: [{ DT_RowId: `row_${id}`, sku: 'T25A-DR2', name: 'DR temp 2' }] });
      const row = await db.selectFrom('os_inventory').selectAll().where('id', '=', id).executeTakeFirst();
      expect(row?.sku).toBe('T25A-DR2');

      // create on the Builder source crashes in PHP (null->create) -> 500.
      const created = await app.inject({
        method: 'POST',
        url: '/inventory.response',
        payload: { action: 'create', data: { 0: { sku: 'x', name: 'y' } } },
      });
      expect(created.statusCode).toBe(500);

      // Remove (validated like the other actions).
      const removed = await app.inject({
        method: 'POST',
        url: '/inventory.response',
        payload: { action: 'remove', data: { [String(id)]: { sku: 'T25A-DR2', name: 'DR temp 2' } } },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ data: [{ DT_RowId: `row_${id}`, sku: 'T25A-DR2', name: 'DR temp 2' }] });
      const gone = await db.selectFrom('os_inventory').select('id').where('id', '=', id).executeTakeFirst();
      expect(gone).toBeFalsy();
    } finally {
      await deleteTempInventory(id);
    }
  });

  it('/inventory.quickUpdate: 422s, 404, insert + update + case-insensitive match', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = asUser(user);
    const productId = await tempProduct({ sku: 'T25A-QU', default_location: 'T25A-QLOC' });
    try {
      const noSku = await app.inject({ method: 'POST', url: '/inventory.quickUpdate', payload: { location: 'AI', qty: '1' } });
      expect(noSku.statusCode).toBe(422);
      expect(noSku.json()).toEqual({ success: false, message: 'Validation failed: The sku field is required.' });

      const badQty = await app.inject({ method: 'POST', url: '/inventory.quickUpdate', payload: { sku: 'T25A-QU', location: 'AI', qty: 'abc' } });
      expect(badQty.statusCode).toBe(422);
      expect((badQty.json() as { message: string }).message).toBe('Validation failed: The qty field must be a number.');

      const negQty = await app.inject({ method: 'POST', url: '/inventory.quickUpdate', payload: { sku: 'T25A-QU', location: 'AI', qty: '-1' } });
      expect(negQty.statusCode).toBe(422);
      expect((negQty.json() as { message: string }).message).toBe('Validation failed: The qty field must be at least 0.');

      const missing = await app.inject({ method: 'POST', url: '/inventory.quickUpdate', payload: { sku: 'T25A-NOPE', location: 'AI', qty: '1' } });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ success: false, message: 'SKU not found.' });

      // New location -> insert. Location is normalised UPPER(TRIM()).
      const created = await app.inject({ method: 'POST', url: '/inventory.quickUpdate', payload: { sku: 'T25A-QU', location: ' t25a-qloc ', qty: '5' } });
      expect(created.statusCode).toBe(200);
      let body = created.json() as { success: boolean; sku: string; locations: { location: string; qty: number }[]; message: string };
      expect(body.success).toBe(true);
      expect(body.sku).toBe('T25A-QU');
      expect(body.locations).toEqual([{ location: 'T25A-QLOC', qty: 5 }]);
      expect(body.message).toBe('Inventory updated successfully.');
      const rows1 = await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', productId).execute();
      expect(rows1.length).toBe(1);
      const locId = Number(rows1[0]['id']);
      expect(rows1[0]['location']).toBe('T25A-QLOC');
      expect(rows1[0]['qty']).toBe(5);

      // Existing location (same id, case-insensitive) -> update in place.
      const updated = await app.inject({ method: 'POST', url: '/inventory.quickUpdate', payload: { sku: 'T25A-QU', location: 'T25A-qloc', qty: '7' } });
      expect(updated.statusCode).toBe(200);
      body = updated.json() as typeof body;
      expect(body.locations).toEqual([{ location: 'T25A-QLOC', qty: 7 }]);
      const rows2 = await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', productId).execute();
      expect(rows2.length).toBe(1);
      expect(Number(rows2[0]['id'])).toBe(locId);
      expect(rows2[0]['qty']).toBe(7);
      await deleteTempProductLocation(locId);
    } finally {
      await db.deleteFrom('os_product_locations').where('product_id', '=', productId).execute();
      await deleteTempProduct(productId);
    }
  });

  it('/inventory.quickUpdate qty<=0 runs ensureDefaultStillStocked (temp product, no live writes)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = asUser(user);
    const productId = await tempProduct({ sku: 'T25A-Q0', default_location: 'T25A-ONLY' });
    let locId = 0;
    try {
      locId = await tempProductLocation(productId, 'T25A-ONLY', 4);
      const res = await app.inject({ method: 'POST', url: '/inventory.quickUpdate', payload: { sku: 'T25A-Q0', location: 'T25A-ONLY', qty: '0' } });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { success: boolean }).success).toBe(true);
      // Default location lost stock and nothing else is stocked -> null.
      const product = await db.selectFrom('os_products').select('default_location').where('id', '=', productId).executeTakeFirst();
      expect(product?.default_location).toBeNull();
    } finally {
      if (locId) await deleteTempProductLocation(locId);
      await db.deleteFrom('os_product_locations').where('product_id', '=', productId).execute();
      await deleteTempProduct(productId);
    }
  });

  it('/inventory.findLocations: 422/404 guards and real-sku results', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = asUser(user);

    const noSku = await app.inject({ method: 'GET', url: '/inventory.findLocations' });
    expect(noSku.statusCode).toBe(422);
    expect(noSku.json()).toEqual({ success: false, message: 'SKU is required.' });

    const emptySku = await app.inject({ method: 'GET', url: '/inventory.findLocations?sku=' });
    expect(emptySku.statusCode).toBe(422);

    const none = await app.inject({ method: 'GET', url: '/inventory.findLocations?sku=T25A-NOMATCH' });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ success: false, message: 'No SKU found matching the pattern.' });

    // A real product with locations (read-only cross-check; merge is a no-op
    // in this DB — the only duplicate group has NULL locations, which skip).
    const product = await db
      .selectFrom('os_products')
      .innerJoin('os_product_locations', 'os_product_locations.product_id', 'os_products.id')
      .select(['os_products.id as pid', 'os_products.sku as sku'])
      .where(sql<boolean>`os_products.sku is not null`)
      .executeTakeFirst();
    if (product) {
      const direct = await db
        .selectFrom('os_product_locations')
        .select(['location', 'qty'])
        .where('product_id', '=', product.pid)
        .orderBy('location')
        .execute();
      const res = await app.inject({ method: 'GET', url: `/inventory.findLocations?sku=${encodeURIComponent(String(product.sku))}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: boolean; locations: Record<string, unknown>[]; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('Locations retrieved successfully.');
      expect(body.locations).toEqual(direct.map((l) => ({ sku: product.sku, location: l.location, qty: l.qty })));
    }
  });
});
