// Vendor users (role 'vendor') are locked into the vendor portal: a global deny-by-default hook, so no route added
// later (or guarded only by `auth`, with no role) can leak to them.
// Allowed: /vendor/*, /login, /logout and static assets. Page requests elsewhere go to /vendor; anything else is 403.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from './auth.js';
import { lredirect } from './http.js';

const STATIC_EXT = /\.(css|js|map|png|jpe?g|gif|svg|ico|woff2?|ttf|eot)$/i;

export function vendorPathAllowed(method: string, urlPath: string): boolean {
  if (urlPath === '/vendor' || urlPath.startsWith('/vendor/')) return true;
  if (urlPath === '/login' || urlPath === '/logout') return true;
  // Static assets (css/js/images) and the public product images under /storage/.
  if ((method === 'GET' || method === 'HEAD') && (STATIC_EXT.test(urlPath) || urlPath.startsWith('/storage/'))) return true;
  return false;
}

export async function vendorLockdown(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Cheap exit: anonymous requests have no session user.
  const sid = (req.session as Record<string, unknown> | undefined)?.['user_id'];
  if (typeof sid !== 'number' || !sid) return;
  const urlPath = (req.raw.url ?? '/').split('?')[0];
  if (vendorPathAllowed(req.method, urlPath)) return;
  const auth = await currentUser(req);
  if (!auth.roles.includes('vendor')) return;
  if (req.method === 'GET' && !urlPath.startsWith('/api/')) {
    lredirect(req, reply, '/vendor');
    return;
  }
  reply.code(403).type('application/json; charset=utf-8').send({ message: 'No Access.' });
}
