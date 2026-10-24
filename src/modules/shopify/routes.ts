// ShopifyController (routes/web.php:288, role:admin,user,remote).
// CallBack returns Response::json("ok") — a JSON string literal body.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { route } from '../../router.js';
import { sendServer500 } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];

export function registerShopifyRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'get',
    path: '/ShopifyCallBack',
    name: 'ShopifyCallBack',
    roles: ROLES,
    // The source method returns JSON "ok", but the controller extends missing BaseController,
    // so Laravel fails while loading the class before CallBack can execute.
    handler: async (req, reply: FastifyReply) => sendServer500(req, reply),
  });
}
