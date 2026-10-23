// HomeController (routes/web.php:35, web + role:admin). `/` and `/home` (both
// named 'home') are registered by T02 (src/modules/auth/routes.ts). The old
// app's HomeController has no report() method, so /report 500s (missing method).

import type { FastifyInstance } from 'fastify';
import { route } from '../../router.js';
import { sendServer500 } from '../../view.js';

export function registerHomeRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'get',
    path: '/report',
    name: 'report',
    middleware: ['web', 'role:admin'],
    handler: sendServer500,
  });
}
