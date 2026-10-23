// T12: ExecController (/exec, /exec.run, /exec.refreshAmz, /refreshAmzImg),
// QueueJobController (/queue, /queue.print, /queue.stuck, /queue.reset_stuck,
// /queue.ping) and PriceController (all three 500: 'Class BaseController not
// found' in the old app).

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerArtisanCommand } from '../src/jobs/artisan.js';
import { registerExecRoutes } from '../src/modules/exec/routes.js';
import { registerPriceRoutes } from '../src/modules/price/routes.js';
import { registerQueueJobRoutes } from '../src/modules/queuejob/routes.js';
import { registerViewPlugins } from '../src/view.js';

async function userWithRole(roles: string[]): Promise<{ id: number } | null> {
  return (
    (await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id'])
      .where('os_roles.name', 'in', roles)
      .executeTakeFirst()) ?? null
  );
}

function buildApp(user: { id: number } | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerExecRoutes(app);
  registerQueueJobRoutes(app);
  registerPriceRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

describe('T12 exec / queuejob / price (fastify inject)', () => {
  afterAll(async () => {
    await db.destroy();
  });

  it('GET /queue: anon -> 302, non-role -> 403, admin -> Jobs page', async () => {
    const anon = buildApp(null);
    let out = await anon.inject({ method: 'GET', url: '/queue' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const supplier = await userWithRole(['supplier']);
    if (supplier) {
      const app = buildApp(supplier);
      out = await app.inject({ method: 'GET', url: '/queue' });
      expect(out.statusCode).toBe(403);
      expect(out.body).toBe('No Access.');
      await app.close();
    }
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    out = await app.inject({ method: 'GET', url: '/queue' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('Queue jobs');
    expect(out.body).toContain('<h1>');
    expect(out.body).toContain('/queue.ping');
    await app.close();
  });

  it('GET /queue.print: known queue -> label imgs, unknown/absent -> empty 200', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    // A real queueId (latest job); the query is read-only.
    const job = await db.selectFrom('os_queuejobs').select('queueId').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (!job) throw new Error('no queuejobs rows in DB');
    const app = buildApp(admin);
    const hit = await app.inject({ method: 'GET', url: `/queue.print?queueId=${job.queueId}` });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers['content-type']).toContain('text/html');
    if (hit.body.includes('<img')) expect(hit.body).toContain("<img src='/getOrderLabel?orderId=");
    expect(hit.body).toContain('<html><body><style>.break { page-break-before: always; }</style>');
    expect(hit.body.endsWith('</body></html>')).toBe(true);

    const miss = await app.inject({ method: 'GET', url: '/queue.print?queueId=99999999' });
    expect(miss.statusCode).toBe(200);
    expect(miss.body).toBe('');
    const noArg = await app.inject({ method: 'GET', url: '/queue.print' });
    expect(noArg.statusCode).toBe(200);
    expect(noArg.body).toBe('');
    await app.close();
  });

  it('GET /queue.stuck renders the stuck-orders page (raw SQL, read-only)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/queue.stuck' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('Stuck orders');
    expect(out.body).toContain('queue.reset_stuck');
    await app.close();
  });

  it('GET /queue.ping: 302 -> /queue and inserts a ping row (cleaned up)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const before = await db.selectFrom('os_queuejobs').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/queue.ping' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/queue');
    const after = await db.selectFrom('os_queuejobs').select(['id', 'type', 'status', 'queueId']).orderBy('id', 'desc').limit(1).executeTakeFirst();
    expect(after).toBeDefined();
    expect(after!.id).toBeGreaterThan(before?.id ?? 0);
    expect(after!.type).toBe('ping');
    expect(after!.status).toBe('start');
    // cleanup: remove the row the test created
    await db.deleteFrom('os_queuejobs').where('id', '=', after!.id).execute();
    await app.close();
  });

  it('price routes all 500 (old app: Class BaseController not found)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    for (const url of ['/price', '/price.ajax', '/price.getRequest.ajax?id=1']) {
      const out = await app.inject({ method: 'GET', url });
      expect(out.statusCode, url).toBe(500);
      expect(out.body).toContain('Internal Server Error');
    }
    await app.close();
  });

  it('GET /exec + /refreshAmzImg: role guards + render', async () => {
    const supplier = await userWithRole(['supplier']);
    if (supplier) {
      const app = buildApp(supplier);
      const out = await app.inject({ method: 'GET', url: '/exec' });
      expect(out.statusCode).toBe(403);
      expect(out.body).toBe('No Access.');
      await app.close();
    }
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/exec' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('name = "what"');
    expect(out.body).toContain('name = "who"');
    out = await app.inject({ method: 'GET', url: '/refreshAmzImg' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('name = "asin"');
    await app.close();
  });

  it('POST /exec.run: unknown command 500s like Laravel; registered command flashes code + 302', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    // Laravel: unregistered command -> InvalidArgumentException -> 500.
    const app = buildApp(admin);
    let out = await app.inject({ method: 'POST', url: '/exec.run', payload: { what: 'nope', who: 'x' } });
    expect(out.statusCode).toBe(500);
    // missing fields: PHP assigns $command=null -> "Command "" is not defined." -> 500.
    out = await app.inject({ method: 'POST', url: '/exec.run', payload: { what: 'nope' } });
    expect(out.statusCode).toBe(500);

    registerArtisanCommand('t12-test-cmd', async () => 0);
    out = await app.inject({ method: 'POST', url: '/exec.run', payload: { what: 't12-test-cmd', who: 'x' } });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/exec');
    await app.close();
  });

  it('POST /exec.refreshAmz: no asin -> 302 refreshAmzImg; asin -> sync cmd (unregistered -> 500)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'POST', url: '/exec.refreshAmz' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/refreshAmzImg');
    // 'sync' is ported in Phase 5; until then the call throws, like Laravel
    // would for an undefined command. Do NOT register it here.
    out = await app.inject({ method: 'POST', url: '/exec.refreshAmz', payload: { asin: 'B0TEST123' } });
    expect(out.statusCode).toBe(500);
    await app.close();
  });
});
