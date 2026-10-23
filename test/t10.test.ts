// T10: /report (missing-method 500), ActionLog (index/store), Settings
// (index, resource missing-methods, save endpoints).

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerActionLogRoutes } from '../src/modules/actionlog/routes.js';
import { registerHomeRoutes } from '../src/modules/home/routes.js';
import { registerSettingsRoutes } from '../src/modules/settings/routes.js';
import { registerViewPlugins } from '../src/view.js';

async function userWithRole(roles: string[]): Promise<{ id: number; username: string } | null> {
  return (
    await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_users.id', 'os_users.username'])
    .where('os_roles.name', 'in', roles)
    .executeTakeFirst()) ?? null;
}

function buildApp(user: { id: number } | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerHomeRoutes(app);
  registerActionLogRoutes(app);
  registerSettingsRoutes(app);
  // force a logged-in user (T02 pattern): hook runs before the route guards.
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

describe('T10 routes (fastify inject)', () => {
  it('GET /actionLogs: anonymous -> 302 /login; with role -> table page', async () => {
    const anon = buildApp(null);
    const out = await anon.inject({ method: 'GET', url: '/actionLogs' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no user-role user in DB');
    const app = buildApp(user);
    const page = await app.inject({ method: 'GET', url: '/actionLogs' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="actionlogstable"');
    expect(page.body).toContain('<th>Action</th>');
    await app.close();
  });

  it('POST /actionLog inserts an os_action_log row (cleaned up)', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no user-role user in DB');
    const action = `t10-test-${Date.now()}`;
    const app = buildApp(user);
    const res = await app.inject({ method: 'POST', url: '/actionLog', payload: { action } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    const row = await db
      .selectFrom('os_action_log')
      .selectAll()
      .where('action', '=', action)
      .executeTakeFirst();
    expect(row).not.toBeNull();
    expect(row!.user_id).toBe(user.id);
    expect(row!.user_name).toBe(user.username);
    expect(row!.created_at).toBeTruthy();
    expect(row!.updated_at).toBeTruthy();
    await db.deleteFrom('os_action_log').where('id', '=', row!.id).execute();
    await app.close();
  });

  it('GET /report: non-admin -> 403 No Access.; admin -> 500 (missing method)', async () => {
    // a role-guarded user who does NOT also hold admin (else 403 wouldn't fire)
    const nonAdmin = await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id', 'os_users.username'])
      .where('os_roles.name', 'in', ['opolo', 'windy', 'four', 'supplier'])
      .where(
        'os_users.id',
        'not in',
        db
          .selectFrom('os_user_has_roles')
          .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
          .select('os_user_has_roles.user_id')
          .where('os_roles.name', '=', 'admin'),
      )
      .executeTakeFirst();
    if (nonAdmin) {
      const app = buildApp(nonAdmin);
      const res = await app.inject({ method: 'GET', url: '/report' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('No Access.');
      await app.close();
    }
    const admin = await userWithRole(['admin']);
    if (admin) {
      const app = buildApp(admin);
      const res = await app.inject({ method: 'GET', url: '/report' });
      expect(res.statusCode).toBe(500);
      expect(res.body).toContain('Internal Server Error');
      await app.close();
    }
    if (!nonAdmin && !admin) throw new Error('no admin/non-admin users in DB');
  });

  it('GET /Settings renders QuickSearch; other resource actions 500', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no user-role user in DB');
    const app = buildApp(user);
    const page = await app.inject({ method: 'GET', url: '/Settings' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="quickSearch"');
    const qs = await db.selectFrom('os_settings').select('value').where('name', '=', 'QuickSearch').executeTakeFirst();
    expect(page.body).toContain(`${qs?.value ?? ''} </textarea>`);
    // Laravel route() is absolute (APP_URL root)
    expect(page.body).toContain('url : \'http://localhost:7000/Settings.saveQuickSearch\'');

    for (const url of ['/Settings/create', '/Settings/1', '/Settings/1/edit']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(500);
      expect(res.body).toContain('Internal Server Error');
    }
    await app.close();
  });

  it('POST /Settings.saveQuickSearch without quickSearch input is a no-op 200', async () => {
    const user = await userWithRole(['admin', 'user', 'remote']);
    if (!user) throw new Error('no user-role user in DB');
    const before = await db
      .selectFrom('os_settings')
      .select(['value', 'updated_at'])
      .where('name', '=', 'QuickSearch')
      .executeTakeFirst();
    const app = buildApp(user);
    const res = await app.inject({ method: 'POST', url: '/Settings.saveQuickSearch', payload: { other: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    const after = await db
      .selectFrom('os_settings')
      .select(['value', 'updated_at'])
      .where('name', '=', 'QuickSearch')
      .executeTakeFirst();
    expect(after).toEqual(before);
    await app.close();
  });
});
