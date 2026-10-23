// GptController (/generateDescription). `auth` middleware from the controller
// constructor (except 'Test', which has no route).

import type { FastifyInstance } from 'fastify';
import { route } from '../../router.js';
import { render } from '../../view.js';

// view('gpt.desc') renders resources/views/gpt/desc.php — a plain PHP view with
// no PHP code, so views/gpt/desc.njk is a byte-for-byte copy.
export function registerGptRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'get',
    path: '/generateDescription',
    name: 'generateDescription',
    middleware: ['web'],
    handler: async (req, reply) => {
      await render(req, reply, 'gpt/desc');
    },
  });
}
