// Users admin: the only way accounts are created, changed or removed (no self-service registration/reset).
// - Admin-only page (/Users, Vue SPA) + JSON API (/api/users).
// - Only the super admin (config.SUPER_ADMIN_EMAIL, johnny@angelisabella.com) can manage OTHER admins: grant/revoke
//   the admin role, create admins, edit/reset/delete them. Other admins manage non-admin users, and may change their
//   own name/email/password (never their own roles, never delete themselves).
// - Vendor logins are not managed here (Vendors page): they have the 'vendor' role, which cannot be assigned here.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser, hashPassword } from '../../auth.js';
import { config } from '../../config.js';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { render } from '../../view.js';

const ROLES = ['admin'];
const clean = (v: unknown): string => String(v ?? '').trim();
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export const isSuperAdminEmail = (email: string | null | undefined): boolean => (email ?? '').trim().toLowerCase() === config.SUPER_ADMIN_EMAIL.trim().toLowerCase();

interface Actor {
  id: number;
  isSuper: boolean;
}

async function actorOf(req: FastifyRequest): Promise<Actor> {
  const auth = await currentUser(req);
  // The route guard already required the admin role, so auth.user is set.
  return { id: auth.user!.id, isSuper: isSuperAdminEmail(auth.user!.email) };
}

interface UserRow {
  id: number;
  username: string;
  name: string | null;
  email: string;
  roles: string[];
}

async function loadUsers(where?: { id: number }): Promise<UserRow[]> {
  let q = db.selectFrom('os_users').select(['id', 'username', 'name', 'email']).orderBy('username');
  if (where) q = q.where('id', '=', where.id);
  const users = await q.execute();
  if (users.length === 0) return [];
  const roleRows = await db
    .selectFrom('os_user_has_roles')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_user_has_roles.user_id as user_id', 'os_roles.name as name'])
    .where('os_user_has_roles.user_id', 'in', users.map((u) => u.id))
    .execute();
  const byUser = new Map<number, string[]>();
  for (const r of roleRows) byUser.set(Number(r.user_id), [...(byUser.get(Number(r.user_id)) ?? []), r.name]);
  return users.map((u) => ({ id: Number(u.id), username: u.username, name: u.name, email: u.email, roles: (byUser.get(Number(u.id)) ?? []).sort() }));
}

// Vendor users are managed on the Vendors page, never here.
async function isVendorUser(u: UserRow): Promise<boolean> {
  if (u.roles.includes('vendor')) return true;
  return (await db.selectFrom('os_vendor_users').select('id').where('user_id', '=', u.id).executeTakeFirst()) != null;
}

// Roles that can be assigned here: every role except 'vendor'; 'admin' only for the super admin.
async function assignableRoles(actor: Actor): Promise<string[]> {
  const all = (await db.selectFrom('os_roles').select('name').orderBy('name').execute()).map((r) => r.name);
  return all.filter((n) => n !== 'vendor' && (n !== 'admin' || actor.isSuper));
}

// What the actor may do to this target (also drives the UI's disabled buttons).
function permissions(actor: Actor, target: UserRow) {
  const self = target.id === actor.id;
  const targetIsAdmin = target.roles.includes('admin');
  const edit = self || actor.isSuper || !targetIsAdmin;
  return {
    is_self: self,
    can_edit: edit, // name / email / username / password
    can_change_roles: !self && (actor.isSuper || !targetIsAdmin),
    can_delete: !self && (actor.isSuper || !targetIsAdmin),
  };
}

function fail(reply: FastifyReply, code: number, message: string): void {
  reply.code(code).send({ success: false, message });
}

function parseRoles(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(list.map((r) => clean(r)).filter((r) => r !== ''))];
}

async function setRoles(trx: typeof db, userId: number, roleNames: string[]): Promise<void> {
  await trx.deleteFrom('os_user_has_roles').where('user_id', '=', userId).execute();
  if (roleNames.length === 0) return;
  const rows = await trx.selectFrom('os_roles').select(['id', 'name']).where('name', 'in', roleNames).execute();
  await trx.insertInto('os_user_has_roles').values(rows.map((r) => ({ role_id: r.id, user_id: userId }))).execute();
}

// ---------------------------------------------------------------- handlers

async function shell(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await render(req, reply, 'product/vue', { title: 'users' });
}

async function apiList(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const actor = await actorOf(req);
  const users: Array<UserRow & ReturnType<typeof permissions>> = [];
  for (const u of await loadUsers()) {
    if (await isVendorUser(u)) continue;
    users.push({ ...u, ...permissions(actor, u) });
  }
  reply.send({ can_manage_admins: actor.isSuper, current_user_id: actor.id, roles: await assignableRoles(actor), users });
}

async function validateRoles(actor: Actor, roles: string[], reply: FastifyReply): Promise<boolean> {
  if (roles.includes('admin') && !actor.isSuper) {
    fail(reply, 403, `Only ${config.SUPER_ADMIN_EMAIL} can grant the admin role`);
    return false;
  }
  const allowed = new Set(await assignableRoles({ ...actor, isSuper: true }));
  if (roles.includes('vendor')) {
    fail(reply, 422, "The vendor role is assigned on the Vendors page");
    return false;
  }
  const unknown = roles.filter((r) => !allowed.has(r));
  if (unknown.length > 0) {
    fail(reply, 422, `Unknown role: ${unknown.join(', ')}`);
    return false;
  }
  return true;
}

async function apiCreate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const actor = await actorOf(req);
  const username = clean(input(req, 'username'));
  const email = clean(input(req, 'email'));
  const name = clean(input(req, 'name'));
  const password = String(input(req, 'password') ?? '');
  const roles = parseRoles(input(req, 'roles')) ?? [];
  if (username === '' || username.length > 255) return fail(reply, 422, 'Username is required');
  if (!EMAIL_RE.test(email) || email.length > 255) return fail(reply, 422, 'A valid email is required');
  if (name.length > 50) return fail(reply, 422, 'Name is too long (max 50)');
  if (password.length < 8) return fail(reply, 422, 'Password must be at least 8 characters');
  if (roles.length === 0) return fail(reply, 422, 'Choose at least one role');
  if (!(await validateRoles(actor, roles, reply))) return;
  const dupe = await db.selectFrom('os_users').select(['username', 'email']).where((eb) => eb.or([eb('username', '=', username), eb('email', '=', email)])).executeTakeFirst();
  if (dupe) return fail(reply, 409, dupe.username.toLowerCase() === username.toLowerCase() ? `Username "${username}" is already taken` : `Email "${email}" is already in use`);
  const now = nowDb();
  const id = await db.transaction().execute(async (trx) => {
    const res = await trx
      .insertInto('os_users')
      .values({ username, email, name: name === '' ? null : name, password: hashPassword(password), confirmation_code: '', confirmed: 1, created_at: now, updated_at: now } as never)
      .executeTakeFirst();
    const userId = Number(res.insertId);
    await setRoles(trx as unknown as typeof db, userId, roles);
    return userId;
  });
  reply.code(201).send({ success: true, id });
}

async function apiUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const actor = await actorOf(req);
  const id = Number((req.params as Record<string, string>)['id']);
  const [target] = await loadUsers({ id });
  if (!target || (await isVendorUser(target))) return fail(reply, 404, 'user not found');
  const perm = permissions(actor, target);
  if (!perm.can_edit) return fail(reply, 403, `Only ${config.SUPER_ADMIN_EMAIL} can manage admins`);

  const set: Record<string, unknown> = {};
  const rawName = input(req, 'name');
  const rawEmail = input(req, 'email');
  const rawUsername = input(req, 'username');
  const password = String(input(req, 'password') ?? '');
  if (rawName !== null && rawName !== undefined) {
    if (clean(rawName).length > 50) return fail(reply, 422, 'Name is too long (max 50)');
    set['name'] = clean(rawName) === '' ? null : clean(rawName);
  }
  if (rawEmail !== null && rawEmail !== undefined && clean(rawEmail) !== '' && clean(rawEmail).toLowerCase() !== target.email.toLowerCase()) {
    const email = clean(rawEmail);
    if (!EMAIL_RE.test(email) || email.length > 255) return fail(reply, 422, 'A valid email is required');
    // the super admin is identified by this email: changing it would silently remove the role
    if (isSuperAdminEmail(target.email)) return fail(reply, 403, 'The super admin email cannot be changed here');
    if (isSuperAdminEmail(email)) return fail(reply, 403, `${config.SUPER_ADMIN_EMAIL} is reserved`);
    const dupe = await db.selectFrom('os_users').select('id').where('email', '=', email).where('id', '!=', id).executeTakeFirst();
    if (dupe) return fail(reply, 409, `Email "${email}" is already in use`);
    set['email'] = email;
  }
  if (rawUsername !== null && rawUsername !== undefined && clean(rawUsername) !== '' && clean(rawUsername) !== target.username) {
    const username = clean(rawUsername);
    if (username.length > 255) return fail(reply, 422, 'Username is too long');
    const dupe = await db.selectFrom('os_users').select('id').where('username', '=', username).where('id', '!=', id).executeTakeFirst();
    if (dupe) return fail(reply, 409, `Username "${username}" is already taken`);
    set['username'] = username;
  }
  if (password !== '') {
    if (password.length < 8) return fail(reply, 422, 'Password must be at least 8 characters');
    set['password'] = hashPassword(password);
    set['remember_token'] = null;
  }
  const roles = parseRoles(input(req, 'roles'));
  const rolesChanged = roles !== null && roles.slice().sort().join(',') !== target.roles.slice().sort().join(',');
  if (rolesChanged) {
    if (!perm.can_change_roles) return fail(reply, 403, perm.is_self ? 'You cannot change your own roles' : `Only ${config.SUPER_ADMIN_EMAIL} can manage admins`);
    if (roles.length === 0) return fail(reply, 422, 'Choose at least one role');
    // Only the super admin can touch the admin role (grant or revoke); validateRoles covers granting.
    if (target.roles.includes('admin') && !roles.includes('admin') && !actor.isSuper) return fail(reply, 403, `Only ${config.SUPER_ADMIN_EMAIL} can revoke the admin role`);
    if (!(await validateRoles(actor, roles, reply))) return;
  }
  if (Object.keys(set).length === 0 && !rolesChanged) return fail(reply, 422, 'nothing to update');
  await db.transaction().execute(async (trx) => {
    if (Object.keys(set).length > 0) await trx.updateTable('os_users').set({ ...set, updated_at: nowDb() } as never).where('id', '=', id).execute();
    if (rolesChanged) await setRoles(trx as unknown as typeof db, id, roles!);
  });
  reply.send({ success: true });
}

async function apiDelete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const actor = await actorOf(req);
  const id = Number((req.params as Record<string, string>)['id']);
  const [target] = await loadUsers({ id });
  if (!target || (await isVendorUser(target))) return fail(reply, 404, 'user not found');
  const perm = permissions(actor, target);
  if (perm.is_self) return fail(reply, 403, 'You cannot delete your own account');
  if (!perm.can_delete) return fail(reply, 403, `Only ${config.SUPER_ADMIN_EMAIL} can manage admins`);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('os_user_has_roles').where('user_id', '=', id).execute();
    await trx.deleteFrom('os_users').where('id', '=', id).execute();
  });
  reply.send({ success: true });
}

export function registerUsersRoutes(app: FastifyInstance): void {
  route(app, { verb: 'get', path: '/Users', name: 'Users', roles: ROLES, handler: shell });
  route(app, { verb: 'get', path: '/api/users', roles: ROLES, handler: apiList });
  route(app, { verb: 'post', path: '/api/users', roles: ROLES, handler: apiCreate });
  route(app, { verb: 'post', path: '/api/users/{id}', roles: ROLES, handler: apiUpdate });
  route(app, { verb: 'delete', path: '/api/users/{id}', roles: ROLES, handler: apiDelete });
}
