// T15: KeywordsController (/Keywords, /AddKeywords, /AddAsin, /GetRank) and
// FbaController (/FBA.Health, /FBA.Orders, /FBA.Inventory, /FBA.Age).
// os_keywords/os_keywords_trend/os_FBA_ORDERS are missing from the DB and
// GetRank's `Client` class does not exist, so those routes 500 (reproduced).

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerFbaRoutes } from '../src/modules/fba/routes.js';
import { registerKeywordsRoutes } from '../src/modules/keywords/routes.js';
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

// A logged-in user with no admin/user/remote role (for the 403 guard test).
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

function buildApp(user: Row | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerKeywordsRoutes(app);
  registerFbaRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

describe('T15 keywords + fba (fastify inject)', () => {
  it('guards: anon -> 302 /login; non-allowed role -> 403 No Access.', async () => {
    const anon = buildApp(null);
    const out = await anon.inject({ method: 'GET', url: '/FBA.Health' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      const res = await app.inject({ method: 'GET', url: '/FBA.Health' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('No Access.');
      await app.close();
    }
  });

  it('FBA pages render (200): Health, Age, Inventory', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const health = await app.inject({ method: 'GET', url: '/FBA.Health' });
    expect(health.statusCode).toBe(200);
    expect(health.body).toContain('sellable qty');
    expect(health.body).toContain('weeks of cover');

    const age = await app.inject({ method: 'GET', url: '/FBA.Age' });
    expect(age.statusCode).toBe(200);
    expect(age.body).toContain('qty in removal progress');

    const inv = await app.inject({ method: 'GET', url: '/FBA.Inventory' });
    expect(inv.statusCode).toBe(200);
    // "bPaginate": true only appears in the inventory view (client-side table).
    expect(inv.body).toContain('"bPaginate": true');
    await app.close();
  });

  it('/FBA.Orders -> 500 (os_FBA_ORDERS missing in the shared DB)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/FBA.Orders' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('Internal Server Error');
    await app.close();
  });

  it('/Keywords -> 500 (os_keywords missing) and /GetRank -> 500 (missing Client class)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const kw = await app.inject({ method: 'GET', url: '/Keywords' });
    expect(kw.statusCode).toBe(500);
    expect(kw.body).toContain('Internal Server Error');

    const rank = await app.inject({ method: 'GET', url: '/GetRank' });
    expect(rank.statusCode).toBe(500);
    expect(rank.body).toContain('Internal Server Error');
    await app.close();
  });

  it('/AddKeywords + /AddAsin: no input -> json "" (200); with input -> 500 (missing table)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no admin/user/remote user in DB');
    const app = buildApp(user);

    const emptyKw = await app.inject({ method: 'POST', url: '/AddKeywords' });
    expect(emptyKw.statusCode).toBe(200);
    expect(emptyKw.headers['content-type']).toContain('json');
    expect(emptyKw.body).toBe('""');

    const emptyAsin = await app.inject({ method: 'POST', url: '/AddAsin' });
    expect(emptyAsin.statusCode).toBe(200);
    expect(emptyAsin.body).toBe('""');

    // With input the handler touches the missing os_keywords table -> 500.
    const kwInput = await app.inject({ method: 'POST', url: '/AddKeywords', payload: { keywords: 'abc' } });
    expect(kwInput.statusCode).toBe(500);
    const asinInput = await app.inject({ method: 'POST', url: '/AddAsin', payload: { keyword: 'abc', asins: 'B0' } });
    expect(asinInput.statusCode).toBe(500);
    await app.close();
  });
});
