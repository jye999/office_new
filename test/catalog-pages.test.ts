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
    .where('os_roles.name', 'in', ['admin', 'user', 'remote'])
    .executeTakeFirst();
  adminId = user?.id ?? 0;
  const products = await db.selectFrom('os_faire_products').select(['id']).where('lifecycle_state', '=', 'PUBLISHED').limit(3).execute();
  ids = products.map((p) => p.id);
});

afterAll(async () => { await db.destroy(); });

describe('/catalog', () => {
  it('lists published Faire products with a title field', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/catalog' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Generate catalog');
    expect(res.body).toContain('name="ids[]"');
  });

  it('adds unpublished products with ?all=1', async () => {
    const some = await buildApp().inject({ method: 'GET', url: '/catalog' });
    const all = await buildApp().inject({ method: 'GET', url: '/catalog?all=1' });
    expect((all.body.match(/name="ids\[\]"/g) ?? []).length).toBeGreaterThan((some.body.match(/name="ids\[\]"/g) ?? []).length);
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
