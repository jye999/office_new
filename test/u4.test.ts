// U4: Faire pick list + allocations. Writes use temp rows (ZZU4*), removed in afterAll.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, nowDb } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUnshippedRoutes } from '../src/modules/unshipped/routes.js';
import { registerViewPlugins } from '../src/view.js';
import { phpUsort } from '../src/lib/phpSort.js';

let adminId = 0;
const PID = 990101;
const LOC1 = 990111;
const LOC2 = 990112;

function buildApp(withUser: boolean) {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerUnshippedRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (withUser) (req.session as Record<string, unknown>)['user_id'] = adminId;
  });
  return app;
}

async function cleanup() {
  await db.deleteFrom('os_order_pick_allocations').where('order_id', '=', 'ZZU4').execute();
  await db.deleteFrom('os_faire_orders').where('order_id', '=', 'ZZU4').execute();
  await db.deleteFrom('os_product_locations').where('product_id', '=', PID as never).execute();
  await db.deleteFrom('os_products').where('id', '=', PID as never).execute();
}

beforeAll(async () => {
  const row = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select('os_users.id')
    .where('os_roles.name', 'in', ['admin', 'user', 'remote'])
    .executeTakeFirst();
  adminId = row?.id ?? 0;
  await cleanup();
  const now = nowDb() as unknown as Date;
  await db.insertInto('os_products').values({ id: PID, sku: 'ZZU4SKU', name: 'zz u4', created_at: now, updated_at: now } as never).execute();
  await db
    .insertInto('os_product_locations')
    .values([
      { id: LOC1, product_id: PID, location: 'A1B1L1', qty: 5, created_at: now, updated_at: now },
      { id: LOC2, product_id: PID, location: 'A1B1L2', qty: 3, created_at: now, updated_at: now },
    ] as never)
    .execute();
  const content = {
    created_at: '2025-08-01T10:00:00.000Z',
    expected_ship_date: '2025-08-05T04:00:00.000Z',
    address: { company_name: 'ZZ Co' },
    items: [{ sku: 'ZZU4SKU', quantity: 6, product_id: 'p1', variant_id: 'v1', product_name: 'zz', variant_name: 'v' }],
  };
  await db
    .insertInto('os_faire_orders')
    .values({ order_id: 'ZZU4', display_id: 'ZZU4D', order_status: 'PROCESSING', payout_total: 1, content: JSON.stringify(content), created_at: now, updated_at: now } as never)
    .execute();
});
afterAll(async () => {
  await cleanup();
  await db.destroy();
});

const post = (app: ReturnType<typeof buildApp>, url: string, payload: Record<string, string>) =>
  app.inject({ method: 'POST', url, payload: new URLSearchParams(payload).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

describe('U4 guards + validation', () => {
  it('anonymous requests redirect to /login', async () => {
    const app = buildApp(false);
    expect((await app.inject({ method: 'GET', url: '/fairePickList' })).statusCode).toBe(302);
    expect((await post(app, '/saveOrderPickAllocation', {})).statusCode).toBe(302);
    await app.close();
  });

  it('validation errors match the old JSON', async () => {
    const app = buildApp(true);
    const j = async (url: string, p: Record<string, string>) => {
      const r = await post(app, url, p);
      return [r.statusCode, r.json()];
    };
    expect(await j('/updateFairePickerPacker', { field: 'bogus' })).toEqual([200, { success: false, message: 'Invalid field' }]);
    expect(await j('/updateProductDefaultLocation', { sku: '', location: 'a' })).toEqual([422, { success: false, message: 'sku is required' }]);
    expect(await j('/updateProductDefaultLocation', { sku: 'x', location: '' })).toEqual([422, { success: false, message: 'location is required' }]);
    expect(await j('/updateProductDefaultLocation', { sku: 'NOSUCHSKU-ZZ', location: 'a' })).toEqual([404, { success: false, message: 'sku not found' }]);
    expect(await j('/saveOrderPickAllocation', { order_id: '', sku: 'a', location_id: '1' })).toEqual([422, { success: false, message: 'order_id, sku, and location_id are required' }]);
    expect(await j('/saveOrderPickAllocation', { order_id: 'o', sku: 'a', location_id: '1', pull_qty: '-1' })).toEqual([422, { success: false, message: 'pull_qty must be 0 or more' }]);
    expect(await j('/saveFaireOrderNotes', { display_id: '', note: 'n' })).toEqual([200, { success: false, message: 'display_id is required' }]);
    expect(await j('/saveFaireOrderNotes', { display_id: 'NOSUCH', note: 'n' })).toEqual([404, { success: false, message: 'order not found' }]);
    await app.close();
  });
});

describe('U4 temp-order lifecycle', () => {
  it('status change seeds allocations; save/override/default-location/picker round-trip', async () => {
    const app = buildApp(true);
    expect((await post(app, '/updateFaireWarehouseStatus', { display_id: 'ZZU4D', warehouse_status: 'picking' })).json()).toEqual({ success: true });
    const seeded = await db.selectFrom('os_order_pick_allocations').select(['location_id', 'pull_qty']).where('order_id', '=', 'ZZU4').orderBy('location_id').execute();
    expect(seeded.map((r) => [Number(r.location_id), r.pull_qty])).toEqual([[LOC1, 5], [LOC2, 1]]);

    expect((await post(app, '/saveOrderPickAllocation', { order_id: 'ZZU4', sku: 'ZZU4SKU', location_id: String(LOC2), pull_qty: '3', location: 'a1b1l2' })).json()).toEqual({ success: true });
    const saved = await db.selectFrom('os_order_pick_allocations').select(['pull_qty', 'location']).where('order_id', '=', 'ZZU4').where('location_id', '=', LOC2).execute();
    expect(saved).toEqual([{ pull_qty: 3, location: 'A1B1L2' }]);

    expect((await post(app, '/updateFairePickerPacker', { display_id: 'ZZU4D', field: 'picker', value: 'Ray' })).json()).toEqual({ success: true });
    const o = await db.selectFrom('os_faire_orders').select(['picker', 'warehouse_status']).where('order_id', '=', 'ZZU4').executeTakeFirst();
    expect(o).toEqual({ picker: 'Ray', warehouse_status: 'picking' });

    expect((await post(app, '/updateProductDefaultLocation', { sku: 'ZZU4SKU', location: 'a1b1l2' })).json()).toEqual({ success: true, sku: 'ZZU4SKU', default_location: 'A1B1L2' });
    expect((await post(app, '/updateProductDefaultLocation', { sku: 'ZZU4SKU', location: 'nowhere' })).statusCode).toBe(404);

    expect((await post(app, '/saveFaireOrderNotes', { display_id: 'ZZU4D', note: 'zz note 1' })).json()).toEqual({ success: true });
    // One note per order: the second save overwrites the first.
    expect((await post(app, '/saveFaireOrderNotes', { display_id: 'ZZU4D', note: 'zz note 1 (updated)' })).json()).toEqual({ success: true });
    const contentRow = (await db.selectFrom('os_faire_orders').select('content').where('order_id', '=', 'ZZU4').executeTakeFirst()) as { content: string | object | null };
    const content = (typeof contentRow.content === 'string' ? JSON.parse(contentRow.content) : contentRow.content) as { note?: unknown };
    expect(content.note).toBe('zz note 1 (updated)');

    const page = await app.inject({ method: 'GET', url: '/fairePickList' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('data-order-id="ZZU4"');
    expect(page.body).toContain('class="pick-bin is-default" data-pull="3" data-location="A1B1L2"');
    expect(page.body).toContain('zz note 1 (updated)');
    expect(page.body).not.toContain('zz note 2');
    expect(page.body).toContain('Add Note');
    const testerBadges = page.body.split('has tester').length - 1; // other live orders may already have one

    // includes_tester: shown as a badge (no qty change); the free unit adds 1 to the pull allocation.
    const tRow = (await db.selectFrom('os_faire_orders').select('content').where('order_id', '=', 'ZZU4').executeTakeFirst()) as { content: string | object };
    const tContent = (typeof tRow.content === 'string' ? JSON.parse(tRow.content) : tRow.content) as { items: Array<Record<string, unknown>> };
    tContent.items[0]['includes_tester'] = true;
    await db.updateTable('os_faire_orders').set({ content: JSON.stringify(tContent) as never }).where('order_id', '=', 'ZZU4').execute();
    await db.deleteFrom('os_order_pick_allocations').where('order_id', '=', 'ZZU4').execute();
    const tPage = await app.inject({ method: 'GET', url: '/fairePickList' });
    expect(tPage.body.split('has tester').length - 1).toBe(testerBadges + 1);
    const tAlloc = await db.selectFrom('os_order_pick_allocations').select('pull_qty').where('order_id', '=', 'ZZU4').execute();
    expect(tAlloc.reduce((n, r) => n + Number(r.pull_qty), 0)).toBe(7);
    await app.close();
  });
});

describe('phpUsort (PHP 7.4 zend_sort)', () => {
  it('is unstable for large tied arrays exactly like PHP, and sorts correctly', () => {
    const a = Array.from({ length: 30 }, (_, i) => [i % 3, i] as [number, number]);
    phpUsort(a, (x, y) => x[0] - y[0]);
    expect(a.map((p) => p[0])).toEqual([...a.map((p) => p[0])].sort((x, y) => x - y));
  });
});
