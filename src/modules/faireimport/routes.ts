// FaireImageImportController (routes/api.php:39): POST /api/products/import-faire-images.
// The old route was unauthenticated and guarded only by the X-Import-Token header;
// the inventory marks it role:admin,user,remote (security change), so the token
// check is kept on top of the session role guard.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import { input } from '../../http.js';
import { importFaireImages } from '../../lib/faireImageImporter.js';
import { route } from '../../router.js';

const ROLES = ['admin', 'user', 'remote'];

// hash_equals((string) $expected, (string) $token)
function hashEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// FILTER_VALIDATE_BOOLEAN: 1/true/on/yes -> true, anything else false.
function filterBoolean(v: unknown): boolean {
  return typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(String(v ?? '').trim().toLowerCase());
}

async function importHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = config.PRODUCT_IMAGE_IMPORT_TOKEN;
  const header = req.headers['x-import-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (!expected || !hashEquals(expected, token ?? '')) return void reply.code(401).send({ error: 'Unauthorized' });
  const sku = input<unknown>(req, 'sku');
  reply.send(await importFaireImages(sku === null ? null : String(sku), filterBoolean(input(req, 'dry_run'))));
}

export function registerFaireImportRoutes(app: FastifyInstance): void {
  route(app, { verb: 'post', path: '/api/products/import-faire-images', roles: ROLES, handler: importHandler });
}
