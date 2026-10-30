// Users admin: admin-only; only the super admin (johnny@angelisabella.com) manages other admins.
// Actors are existing accounts (never modified); everything written uses temp users (zzu*), removed in afterAll.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth.js';
import { db } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { installRouter } from '../src/router.js';
import { registerUsersRoutes } from '../src/modules/users/routes.js';
import { registerVendorUserRoutes } from '../src/modules/vendor/users.js';
import { registerVendorRoutes } from '../src/modules/vendor/routes.js';
import { vendorLockdown } from '../src/vendorAccess.js';
import { registerViewPlugins } from '../src/view.js';

let superId = 0;
let otherAdminId = 0;
let plainUserId = 0; // an existing non-admin account with the 'user' role
const TEMPS = ['zzu_user1', 'zzu_user2', 'zzu_admin1', 'zzu_admin2', 'zzu_vendor'];

function buildApp() {
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  installRouter(app);
  app.addHook('preHandler', async (req) => {
    const id = Number(req.headers['x-test-user'] ?? 0);
    if (id) (req.session as Record<string, unknown>)['user_id'] = id;
  });
  app.addHook('preHandler', vendorLockdown);
  registerUsersRoutes(app);
  registerVendorRoutes(app);
  registerVendorUserRoutes(app);
  return app;
}
type App = ReturnType<typeof buildApp>;

const call = (app: App, method: 'GET' | 'POST' | 'DELETE', url: string, as: number, body?: Record<string, unknown>) =>
  app.inject({ method, url, payload: body as never, headers: { 'x-test-user': String(as) } });

async function cleanup() {
  const users = await db.selectFrom('os_users').select('id').where('username', 'in', TEMPS).execute();
  for (const u of users) await db.deleteFrom('os_user_has_roles').where('user_id', '=', u.id).execute();
  await db.deleteFrom('os_users').where('username', 'in', TEMPS).execute();
  await db.deleteFrom('os_vendors').where('name', '=', 'ZZ Users Vendor').execute();
}

async function roleNames(id: number): Promise<string[]> {
  return (await db.selectFrom('os_user_has_roles').innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id').select('os_roles.name').where('user_id', '=', id).execute()).map((r) => r.name).sort();
}

beforeAll(async () => {
  await cleanup();
  const admins = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_users.id as id', 'os_users.email as email'])
    .where('os_roles.name', '=', 'admin')
    .execute();
  superId = Number(admins.find((a) => a.email.toLowerCase() === 'johnny@angelisabella.com')?.id ?? 0);
  otherAdminId = Number(admins.find((a) => a.email.toLowerCase() !== 'johnny@angelisabella.com')?.id ?? 0);
  const plain = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select('os_users.id as id')
    .where('os_roles.name', '=', 'user')
    .where('os_users.id', 'not in', admins.map((a) => Number(a.id)))
    .executeTakeFirst();
  plainUserId = Number(plain?.id ?? 0);
});
afterAll(cleanup);

describe('users admin', () => {
  it('needs the admin role', async () => {
    expect(superId).toBeGreaterThan(0);
    expect(otherAdminId).toBeGreaterThan(0);
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(302); // anonymous -> login
    if (plainUserId > 0) {
      for (const [m, u] of [['GET', '/api/users'], ['POST', '/api/users'], ['GET', '/Users']] as const) expect((await call(app, m, u, plainUserId)).statusCode, `${m} ${u}`).toBe(403);
    }
    expect((await call(app, 'GET', '/Users', otherAdminId)).statusCode).toBe(200);
    await app.close();
  });

  it('a normal admin manages non-admin users but not admins; only the super admin manages admins', async () => {
    const app = buildApp();

    // listing: flags + assignable roles depend on who asks
    const asOther = (await call(app, 'GET', '/api/users', otherAdminId)).json();
    expect(asOther.can_manage_admins).toBe(false);
    expect(asOther.roles).not.toContain('admin');
    expect(asOther.roles).not.toContain('vendor');
    const johnnyRow = asOther.users.find((u: { id: number }) => u.id === superId);
    expect(johnnyRow).toMatchObject({ can_edit: false, can_change_roles: false, can_delete: false });
    const asSuper = (await call(app, 'GET', '/api/users', superId)).json();
    expect(asSuper.can_manage_admins).toBe(true);
    expect(asSuper.roles).toContain('admin');
    expect(asSuper.users.find((u: { id: number }) => u.id === superId)).toMatchObject({ is_self: true, can_delete: false, can_change_roles: false });

    // normal admin: create a plain user (ok), an admin (403), validation, duplicates
    const u1 = await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_user1', email: 'zzu1@example.com', name: 'U One', password: 'password-one-1', roles: ['user'] });
    expect(u1.statusCode).toBe(201);
    const u1Id = u1.json().id as number;
    expect(await roleNames(u1Id)).toEqual(['user']);
    const stored = await db.selectFrom('os_users').select('password').where('id', '=', u1Id).executeTakeFirst();
    expect(stored?.password).not.toBe('password-one-1');
    expect(verifyPassword('password-one-1', String(stored?.password))).toBe(true);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_admin1', email: 'zzua1@example.com', password: 'password-adm-1', roles: ['admin'] })).statusCode).toBe(403);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_user2', email: 'zzu2@example.com', password: 'password-two-2', roles: ['user', 'admin'] })).statusCode).toBe(403);
    expect(await db.selectFrom('os_users').select('id').where('username', 'in', ['zzu_admin1', 'zzu_user2']).execute()).toHaveLength(0);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_user2', email: 'zzu2@example.com', password: 'short', roles: ['user'] })).statusCode).toBe(422);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_user2', email: 'bad', password: 'password-two-2', roles: ['user'] })).statusCode).toBe(422);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_user2', email: 'zzu2@example.com', password: 'password-two-2', roles: [] })).statusCode).toBe(422);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_user2', email: 'zzu2@example.com', password: 'password-two-2', roles: ['nonsense'] })).statusCode).toBe(422);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_user2', email: 'zzu2@example.com', password: 'password-two-2', roles: ['vendor'] })).statusCode).toBe(422);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'ZZU_USER1', email: 'other@example.com', password: 'password-two-2', roles: ['user'] })).statusCode).toBe(409);
    expect((await call(app, 'POST', '/api/users', otherAdminId, { username: 'zzu_user2', email: 'zzu1@example.com', password: 'password-two-2', roles: ['user'] })).statusCode).toBe(409);

    // normal admin edits a non-admin: name, email, roles, password reset
    expect((await call(app, 'POST', `/api/users/${u1Id}`, otherAdminId, { name: 'U One B', email: 'zzu1b@example.com', roles: ['user', 'remote'] })).json()).toEqual({ success: true });
    expect(await roleNames(u1Id)).toEqual(['remote', 'user']);
    expect((await call(app, 'POST', `/api/users/${u1Id}`, otherAdminId, { password: 'brand-new-pass-9' })).json()).toEqual({ success: true });
    expect(verifyPassword('brand-new-pass-9', String((await db.selectFrom('os_users').select('password').where('id', '=', u1Id).executeTakeFirst())?.password))).toBe(true);
    // ...but cannot grant admin to them
    expect((await call(app, 'POST', `/api/users/${u1Id}`, otherAdminId, { roles: ['user', 'admin'] })).statusCode).toBe(403);
    expect(await roleNames(u1Id)).toEqual(['remote', 'user']);

    // normal admin cannot touch the super admin (edit / password / roles / delete) — nothing changes
    const before = await db.selectFrom('os_users').select(['email', 'password', 'name']).where('id', '=', superId).executeTakeFirst();
    const rolesBefore = await roleNames(superId);
    for (const body of [{ name: 'hacked' }, { password: 'hacked-password-1' }, { roles: ['user'] }, { email: 'x@example.com' }]) {
      expect((await call(app, 'POST', `/api/users/${superId}`, otherAdminId, body)).statusCode, JSON.stringify(body)).toBe(403);
    }
    expect((await call(app, 'DELETE', `/api/users/${superId}`, otherAdminId)).statusCode).toBe(403);
    expect(await db.selectFrom('os_users').select(['email', 'password', 'name']).where('id', '=', superId).executeTakeFirst()).toEqual(before);
    expect(await roleNames(superId)).toEqual(rolesBefore);

    // super admin creates admins and can manage them
    const a1 = await call(app, 'POST', '/api/users', superId, { username: 'zzu_admin1', email: 'zzua1@example.com', password: 'password-adm-1', roles: ['admin', 'user'] });
    expect(a1.statusCode).toBe(201);
    const a1Id = a1.json().id as number;
    expect(await roleNames(a1Id)).toEqual(['admin', 'user']);
    const a2Id = (await call(app, 'POST', '/api/users', superId, { username: 'zzu_admin2', email: 'zzua2@example.com', password: 'password-adm-2', roles: ['admin'] })).json().id as number;

    // a normal (non-super) admin cannot manage other admins — even one created by the super admin
    const asA1 = (id: number, m: 'POST' | 'DELETE', body?: Record<string, unknown>) => call(app, m, `/api/users/${id}`, a1Id, body);
    expect((await asA1(a2Id, 'POST', { name: 'nope' })).statusCode).toBe(403);
    expect((await asA1(a2Id, 'POST', { password: 'hacked-password-1' })).statusCode).toBe(403);
    expect((await asA1(a2Id, 'POST', { roles: ['user'] })).statusCode).toBe(403);
    expect((await asA1(a2Id, 'DELETE')).statusCode).toBe(403);
    expect(await roleNames(a2Id)).toEqual(['admin']);
    // ...but can manage plain users, and themselves (name/password only)
    expect((await asA1(u1Id, 'POST', { name: 'by admin1' })).json()).toEqual({ success: true });
    expect((await asA1(a1Id, 'POST', { name: 'Admin One', password: 'password-adm-1b' })).json()).toEqual({ success: true });
    expect((await asA1(a1Id, 'POST', { roles: ['user'] })).statusCode).toBe(403); // not their own roles
    expect((await asA1(a1Id, 'DELETE')).statusCode).toBe(403); // nor delete themselves
    expect(await roleNames(a1Id)).toEqual(['admin', 'user']);
    // grant/revoke admin on others: only super
    expect((await asA1(u1Id, 'POST', { roles: ['user', 'admin'] })).statusCode).toBe(403);

    // super admin: revoke admin, edit, reset password, delete another admin
    expect((await call(app, 'POST', `/api/users/${a2Id}`, superId, { roles: ['user'], password: 'password-adm-2b' })).json()).toEqual({ success: true });
    expect(await roleNames(a2Id)).toEqual(['user']);
    expect((await call(app, 'POST', `/api/users/${u1Id}`, superId, { roles: ['user', 'admin'] })).json()).toEqual({ success: true });
    expect(await roleNames(u1Id)).toEqual(['admin', 'user']);
    expect((await call(app, 'DELETE', `/api/users/${a1Id}`, superId)).json()).toEqual({ success: true });
    expect(await db.selectFrom('os_users').select('id').where('id', '=', a1Id).executeTakeFirst()).toBeUndefined();
    expect(await roleNames(a1Id)).toEqual([]);

    // super admin protections: cannot delete self, change own roles or email
    expect((await call(app, 'DELETE', `/api/users/${superId}`, superId)).statusCode).toBe(403);
    expect((await call(app, 'POST', `/api/users/${superId}`, superId, { roles: ['user'] })).statusCode).toBe(403);
    expect((await call(app, 'POST', `/api/users/${superId}`, superId, { email: 'someone@example.com' })).statusCode).toBe(403);
    expect(await roleNames(superId)).toEqual(rolesBefore);
    // nobody can take over the super admin address
    expect((await call(app, 'POST', `/api/users/${u1Id}`, superId, { email: 'JOHNNY@angelisabella.com' })).statusCode).toBe(403);

    // unknown user
    expect((await call(app, 'POST', '/api/users/999999999', superId, { name: 'x' })).statusCode).toBe(404);
    expect((await call(app, 'DELETE', '/api/users/999999999', superId)).statusCode).toBe(404);
    await app.close();
  });

  it('vendor logins are not managed here', async () => {
    const app = buildApp();
    const v = (await call(app, 'POST', '/api/vendors', otherAdminId, { name: 'ZZ Users Vendor' })).json().id as number;
    const vu = (await call(app, 'POST', `/api/vendors/${v}/users`, superId, { username: 'zzu_vendor', email: 'zzuv@example.com', password: 'password-ven-1' })).json().id as number;
    const list = (await call(app, 'GET', '/api/users', superId)).json() as { users: Array<{ id: number }> };
    expect(list.users.find((u) => u.id === vu)).toBeUndefined();
    expect((await call(app, 'POST', `/api/users/${vu}`, superId, { roles: ['admin'] })).statusCode).toBe(404);
    expect((await call(app, 'POST', `/api/users/${vu}`, superId, { password: 'password-hack-1' })).statusCode).toBe(404);
    expect((await call(app, 'DELETE', `/api/users/${vu}`, superId)).statusCode).toBe(404);
    expect(await roleNames(vu)).toEqual(['vendor']);
    // vendor logins also cannot use the Users API
    expect([302, 403]).toContain((await call(app, 'GET', '/api/users', vu)).statusCode);
    expect((await call(app, 'POST', '/api/users', vu, { username: 'x', email: 'x@example.com', password: 'password-x-1', roles: ['admin'] })).statusCode).toBe(403);
    await db.deleteFrom('os_vendor_users').where('user_id', '=', vu).execute();
    await app.close();
  });
});
