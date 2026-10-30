// Admin APIs to manage vendor logins (os_users with role 'vendor', linked to one vendor in os_vendor_users).
// Admin-only: staff with the user/remote roles cannot create logins.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword } from '../../auth.js';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';

const ROLES = ['admin'];
const clean = (v: unknown): string => String(v ?? '').trim();

async function vendorRoleId(): Promise<number | null> {
  const r = await db.selectFrom('os_roles').select('id').where('name', '=', 'vendor').executeTakeFirst();
  return r ? Number(r.id) : null;
}

export async function listVendorUsers(vendorId: number) {
  return db
    .selectFrom('os_vendor_users')
    .innerJoin('os_users', 'os_users.id', 'os_vendor_users.user_id')
    .select(['os_users.id as id', 'os_users.username as username', 'os_users.name as name', 'os_users.email as email'])
    .where('os_vendor_users.vendor_id', '=', vendorId)
    .orderBy('os_users.username')
    .execute();
}

function validPassword(pw: string): string | null {
  return pw.length < 8 ? 'Password must be at least 8 characters' : null;
}

async function apiList(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const vendorId = Number((req.params as Record<string, string>)['id']);
  const vendor = await db.selectFrom('os_vendors').select('id').where('id', '=', vendorId).executeTakeFirst();
  if (!vendor) return reply.code(404).send({ success: false, message: 'vendor not found' });
  reply.send(await listVendorUsers(vendorId));
}

async function apiCreate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const vendorId = Number((req.params as Record<string, string>)['id']);
  const vendor = await db.selectFrom('os_vendors').select('id').where('id', '=', vendorId).executeTakeFirst();
  if (!vendor) return reply.code(404).send({ success: false, message: 'vendor not found' });
  const username = clean(input(req, 'username'));
  const email = clean(input(req, 'email'));
  const name = clean(input(req, 'name'));
  const password = String(input(req, 'password') ?? '');
  if (username === '' || username.length > 255) return reply.code(422).send({ success: false, message: 'Username is required' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return reply.code(422).send({ success: false, message: 'A valid email is required' });
  if (name.length > 50) return reply.code(422).send({ success: false, message: 'Name is too long (max 50)' });
  const pwError = validPassword(password);
  if (pwError) return reply.code(422).send({ success: false, message: pwError });
  const dupe = await db
    .selectFrom('os_users')
    .select(['username', 'email'])
    .where((eb) => eb.or([eb('username', '=', username), eb('email', '=', email)]))
    .executeTakeFirst();
  if (dupe) return reply.code(409).send({ success: false, message: dupe.username.toLowerCase() === username.toLowerCase() ? `Username "${username}" is already taken` : `Email "${email}" is already in use` });
  const roleId = await vendorRoleId();
  if (roleId === null) return reply.code(500).send({ success: false, message: "role 'vendor' is missing (run scripts/sql/vendor-users.sql)" });

  const now = nowDb();
  const userId = await db.transaction().execute(async (trx) => {
    const res = await trx
      .insertInto('os_users')
      .values({ username, email, name: name === '' ? null : name, password: hashPassword(password), confirmation_code: '', confirmed: 1, created_at: now, updated_at: now } as never)
      .executeTakeFirst();
    const id = Number(res.insertId);
    await trx.insertInto('os_user_has_roles').values({ role_id: roleId, user_id: id } as never).execute();
    await trx.insertInto('os_vendor_users').values({ user_id: id, vendor_id: vendorId, created_at: now, updated_at: now } as never).execute();
    return id;
  });
  reply.code(201).send({ success: true, id: userId, username, name: name === '' ? null : name, email });
}

// The user must be a vendor user (linked in os_vendor_users); other users are never touched through these routes.
async function vendorUser(userId: number) {
  return db.selectFrom('os_vendor_users').select(['user_id', 'vendor_id']).where('user_id', '=', userId).executeTakeFirst();
}

async function apiUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = Number((req.params as Record<string, string>)['userId']);
  if (!(await vendorUser(userId))) return reply.code(404).send({ success: false, message: 'vendor user not found' });
  const set: Record<string, unknown> = {};
  const rawName = input(req, 'name');
  const rawEmail = input(req, 'email');
  const password = String(input(req, 'password') ?? '');
  if (rawName !== null && rawName !== undefined) {
    if (clean(rawName).length > 50) return reply.code(422).send({ success: false, message: 'Name is too long (max 50)' });
    set['name'] = clean(rawName) === '' ? null : clean(rawName);
  }
  if (rawEmail !== null && rawEmail !== undefined && clean(rawEmail) !== '') {
    const email = clean(rawEmail);
    if (!/^\S+@\S+\.\S+$/.test(email)) return reply.code(422).send({ success: false, message: 'A valid email is required' });
    const dupe = await db.selectFrom('os_users').select('id').where('email', '=', email).where('id', '!=', userId).executeTakeFirst();
    if (dupe) return reply.code(409).send({ success: false, message: `Email "${email}" is already in use` });
    set['email'] = email;
  }
  if (password !== '') {
    const pwError = validPassword(password);
    if (pwError) return reply.code(422).send({ success: false, message: pwError });
    set['password'] = hashPassword(password);
    set['remember_token'] = null; // invalidates any remember-me cookie
  }
  if (Object.keys(set).length === 0) return reply.code(422).send({ success: false, message: 'nothing to update' });
  await db.updateTable('os_users').set({ ...set, updated_at: nowDb() } as never).where('id', '=', userId).execute();
  reply.send({ success: true });
}

async function apiDelete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = Number((req.params as Record<string, string>)['userId']);
  if (!(await vendorUser(userId))) return reply.code(404).send({ success: false, message: 'vendor user not found' });
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('os_vendor_users').where('user_id', '=', userId).execute();
    await trx.deleteFrom('os_user_has_roles').where('user_id', '=', userId).execute();
    await trx.deleteFrom('os_users').where('id', '=', userId).execute();
  });
  reply.send({ success: true });
}

export function registerVendorUserRoutes(app: FastifyInstance): void {
  route(app, { verb: 'get', path: '/api/vendors/{id}/users', roles: ROLES, handler: apiList });
  route(app, { verb: 'post', path: '/api/vendors/{id}/users', roles: ROLES, handler: apiCreate });
  route(app, { verb: 'post', path: '/api/vendor-users/{userId}', roles: ROLES, handler: apiUpdate });
  route(app, { verb: 'delete', path: '/api/vendor-users/{userId}', roles: ROLES, handler: apiDelete });
}
