// Catalog pages: /catalog picker and /catalog/view flipbook against real
// os_faire_products rows. Read-only; no writes.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { registerCatalogRoutes } from '../src/modules/catalog/routes.js';
import { installRouter } from '../src/router.js';
import { registerViewPlugins } from '../src/view.js';

let adminId = 0;
let ids: string[] = [];

function buildApp() {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerCatalogRoutes(app);
  app.addHook('preHandler', async (req) => {
    (req.session as Record<string, unknown>)['user_id'] = adminId;
  });
  return app;
}

beforeAll(async () => {
  const user = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select('os_users.id')
    .where('os_roles.name', 'in', ['admin'])
    .executeTakeFirst();
  adminId = user?.id ?? 0;
  const products = await db.selectFrom('os_faire_products').select(['id']).where('lifecycle_state', '=', 'PUBLISHED').limit(3).execute();
  ids = products.map((p) => p.id);
});

afterAll(async () => { await db.destroy(); });

describe('/catalog access', () => {
  it('refuses a signed-in user who is not an admin', async () => {
    const other = await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select('os_users.id')
      .where('os_roles.name', 'in', ['user', 'remote'])
      .where('os_users.id', 'not in', db.selectFrom('os_user_has_roles').innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id').select('os_user_has_roles.user_id').where('os_roles.name', '=', 'admin'))
      .executeTakeFirst();
    if (!other) return;
    const app = buildApp();
    app.addHook('preHandler', async (req) => { (req.session as Record<string, unknown>)['user_id'] = other.id; });
    for (const url of ['/catalog', '/catalog/view']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('/catalog', () => {
  it('lists published Faire products with a title field', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/catalog' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Generate catalog');
    expect(res.body).toContain('name="ids[]"');
  });

  it('lists only published products, each product once', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/catalog' });
    const shown = [...res.body.matchAll(/name="ids\[\]" value="([^"]+)"/g)].map((m) => m[1]);
    const rows = await db.selectFrom('os_faire_products').select(['id', 'name', 'lifecycle_state']).where('id', 'in', shown).execute();
    expect(rows.every((r) => r.lifecycle_state === 'PUBLISHED')).toBe(true);
    const names = rows.map((r) => String(r.name).trim().toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('/catalog/view', () => {
  it('renders a flipbook with cover, contents and product pages', async () => {
    const res = await buildApp().inject({ method: 'GET', url: `/catalog/view?title=Spring&ids[]=${ids.join('&ids[]=')}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Spring');
    expect(res.body).toContain('class="page cover"');
    expect(res.body).toContain('class="page contents"');
    expect(res.body).toContain('class="page products"');
    expect(res.body).toContain('id="book"');
    expect(res.body).toContain('Contents');
  });

  it('sends a bare request back to the picker with an error', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/catalog/view' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/catalog');
  });
});

describe('catalog drafts', () => {
  it('saves a draft with an image override and reopens it with that image', async () => {
    const app = buildApp();
    const pick = 'https://example.com/picked.jpg';
    const body = `name=Test+draft&title=Spring&ids=${ids.join(',')}&overrides=${encodeURIComponent(JSON.stringify({ [ids[0]]: pick, [ids[1]]: 'javascript:alert(1)' }))}`;
    const saved = await app.inject({ method: 'POST', url: '/catalog/drafts', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: body });
    const { id } = saved.json() as { id: number };
    try {
      expect(id).toBeGreaterThan(0);
      const res = await app.inject({ method: 'GET', url: `/catalog/view?draft=${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(pick);
      expect(res.body).not.toContain('javascript:alert');
    } finally {
      await db.deleteFrom('os_catalog_drafts').where('id', '=', id).execute();
    }
  });
});

describe('/catalog/open', () => {
  it('turns a posted selection into a short ?draft= link that renders', async () => {
    const app = buildApp();
    const payload = `title=Spring&${ids.map((id) => `ids[]=${id}`).join('&')}`;
    const res = await app.inject({ method: 'POST', url: '/catalog/open', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload });
    expect(res.statusCode).toBe(302);
    const loc = String(res.headers.location);
    const id = Number(/draft=(\d+)/.exec(loc)?.[1]);
    try {
      expect(loc.length).toBeLessThan(120);
      const page = await app.inject({ method: 'GET', url: `/catalog/view?draft=${id}` });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Spring');
    } finally {
      await db.deleteFrom('os_catalog_drafts').where('id', '=', id).execute();
    }
  });
});

describe('/catalog with saved drafts', () => {
  it('lists a saved draft on the picker', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/catalog/drafts', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `name=Listed+draft&ids=${ids.join(',')}` });
    const { id } = res.json() as { id: number };
    try {
      const page = await app.inject({ method: 'GET', url: '/catalog' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Listed draft');
    } finally {
      await db.deleteFrom('os_catalog_drafts').where('id', '=', id).execute();
    }
  });
});
