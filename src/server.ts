import fastifyStatic from '@fastify/static';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { config } from './config.js';
import { db, sql } from './db.js';

const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } });

await app.register(formbody);
await app.register(multipart, { attachFieldsToBody: false });
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
