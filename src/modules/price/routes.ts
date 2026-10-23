// PriceController (routes/web.php:282-284, role:admin,user,remote).
// The old controller extends `\BaseController` — a class that does not exist in
// the old app — so EVERY action fatals with `Class 'BaseController' not found`
// (500) before doing anything. Ported as sendServer500, same pattern as T10's
// missing-method 500s (see NOTES.md). views/price/index.njk is ported but,
// like in the old app, never reached.

import type { FastifyInstance } from 'fastify';
import { route } from '../../router.js';
import { sendServer500 } from '../../view.js';

export function registerPriceRoutes(app: FastifyInstance): void {
  const middleware = ['web', 'role:admin,user,remote'];
  for (const [verb, path, name] of [
    ['get', '/price', 'price'],
    ['get', '/price.ajax', 'price.ajax'],
    ['get', '/price.getRequest.ajax', 'price.getRequest.ajax'],
  ] as const) {
    route(app, {
      verb,
      path,
      name,
      middleware,
      handler: async (req, reply) => {
        await sendServer500(req, reply);
      },
    });
  }
}
