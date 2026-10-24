// AmzAdController (routes/web.php:20 'echo', :110 'amz_signin' role:admin,user,remote).
// Both actions just echo "hi" (text/html).

import type { FastifyInstance } from 'fastify';
import { route } from '../../router.js';

const ROLES = ['admin', 'user', 'remote'];
const HI = { type: 'text/html; charset=UTF-8', body: 'hi' };

export function registerAmzadRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'get',
    path: '/echo',
    name: 'echo',
    handler: async (req, reply) => reply.type(HI.type).send(HI.body),
  });

  route(app, {
    verb: 'get',
    path: '/amz_signin',
    name: 'amzSignIn',
    roles: ROLES,
    handler: async (req, reply) => reply.type(HI.type).send(HI.body),
  });
}
