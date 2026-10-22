import fastifyStatic from '@fastify/static';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { config } from './config.js';
import { db, sql } from './db.js';
import { registerViewPlugins, render } from './view.js';
import { registerHttpHelpers } from './http.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerApiAuthRoutes } from './modules/api/routes.js';

const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } });

await app.register(formbody);
await app.register(multipart, { attachFieldsToBody: false });
// registerHttpHelpers before the session plugin: its onSend must run first
// (onSend hooks are FIFO) so flashed errors/old input are consumed once.
await app.register(registerHttpHelpers);
await registerViewPlugins(app);
registerAuthRoutes(app);
registerApiAuthRoutes(app);

// T01 dev-only test route: renders a page extending `layout` (see views/layout-test.njk).
if (process.env.NODE_ENV !== 'production') {
  app.get('/__layout-test', async (req, reply) => {
    await render(req, reply, 'layout-test', { flash: 'yes' });
  });
}
await app.register(fastifyStatic, {
  root: config.PUBLIC_DIR,
  wildcard: true,
  decorateReply: true,
});

app.get('/__health', async () => {
  const { rows } = await sql<{ one: number }>`select 1 as one`.execute(db);
  return { ok: true, db: rows[0]?.one };
});

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
