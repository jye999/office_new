// POST /catalog/curate and the cached picks the viewer reads. The model answer is
// stubbed; the row this writes is deleted again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import { db } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { registerCatalogRoutes } from '../src/modules/catalog/routes.js';
import { installRouter } from '../src/router.js';
import { registerViewPlugins } from '../src/view.js';
import { setOpenAiPostForTests } from '../src/lib/chatService.js';

const live = await db
  .selectFrom('os_faire_products')
  .select('id')
  .where('lifecycle_state', '=', 'PUBLISHED')
  .where('id', 'not in', (eb) => eb.selectFrom('os_catalog_curation').select('faire_id'))
  .orderBy('id', 'asc')
  .limit(1)
  .execute()
  .then((rows) => rows[0]?.id ?? null)
  .catch(() => null);

let app: FastifyInstance | null = null;

beforeAll(async () => {
  if (!live) return;
  app = Fastify({ querystringParser: parseLaravelQuery, logger: false });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  registerCatalogRoutes(app);
  app.addHook('preHandler', async (req) => {
    (req.session as Record<string, unknown>)['user_id'] = 1;
  });
  await app.ready();
  setOpenAiPostForTests(async () => ({ choices: [{ message: { content: '{"hero": 0, "extras": [1], "layout": "half"}' } }] }));
});

afterAll(async () => {
  setOpenAiPostForTests(null);
  if (live) await db.deleteFrom('os_catalog_curation').where('faire_id', '=', live).execute();
  if (app) await app.close();
});

describe.skipIf(!live)('catalog curation route', () => {
  it('refuses to curate nothing', async () => {
    const res = await app!.inject({ method: 'POST', url: '/catalog/curate' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, message: 'Select products first.' });
  });

  it('stores the model pick under the Faire id', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/catalog/curate',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `ids[]=${live}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, curated: 1, from_model: 1 });

    const stored = await db.selectFrom('os_catalog_curation').select(['hero_url', 'layout', 'model']).where('faire_id', '=', live!).execute();
    expect(stored[0]?.layout).toBe('half');
    expect(String(stored[0]?.hero_url)).toContain('cdn.faire.com');

    const page = await app!.inject({ method: 'GET', url: `/catalog/view?title=T&ids[]=${live}` });
    // One item on a page grows to fill it, so the half pick renders as a full page here.
    expect(page.body).toContain('class="item full"');
  });

  it('does not call the model again for a product already curated', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/catalog/curate',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `ids[]=${live}`,
    });
    expect(res.json()).toMatchObject({ ok: true, curated: 0, already_had: 1 });
  });
});
