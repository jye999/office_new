// T01 stub — T02 owns full auth (guards, role middleware, PDA api-key).
// Provides just enough for `render()` to inject `auth` ({user, roles}).

import '@fastify/flash';
import '@fastify/secure-session';
import type { FastifyRequest } from 'fastify';
import { db } from './db.js';

export interface AuthUser {
  id: number;
  name: string | null;
  email: string;
  username: string;
  company_id: number;
}

export interface Auth {
  user: AuthUser | null;
  roles: string[];
}

// Session contract with T02: the web session stores the logged-in user's id as
// `user_id` (mirrors the old app's session-auth lookup).
export async function currentUser(req: FastifyRequest): Promise<Auth> {
  const id = (req.session as Record<string, unknown> | undefined)?.user_id;
  if (typeof id !== 'number' || !id) return { user: null, roles: [] };
  const user = await db
    .selectFrom('os_users')
    .select(['id', 'name', 'email', 'username', 'company_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!user) return { user: null, roles: [] };
  const roleRows = await db
    .selectFrom('os_user_has_roles')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select('os_roles.name')
    .where('os_user_has_roles.user_id', '=', id)
    .execute();
  return { user, roles: roleRows.map((r) => r.name) };
}

// spatie/laravel-permission @role([...]): true when the user has any of the roles.
export function hasRole(auth: Auth, roles: string | string[]): boolean {
  if (!auth.user) return false;
  const list = Array.isArray(roles) ? roles : [roles];
  return list.some((r) => auth.roles.includes(r));
}
