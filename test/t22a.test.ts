// T22a: ReportController sales routes (/SalesReport, /SalesTaxReport,
// /SalesSnapshotReport). The SalesReport stored procedure is missing from the
// DB, so Sales() and SalesSnapshot() 500 on their first DB::select (reproduced
// via sendServer500); SalesTax() calls the SalesTaxReport procedure, which
// exists.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerReportRoutes } from '../src/modules/report/routes.js';
import { registerViewPlugins } from '../src/view.js';

type Row = { id: number };

async function userWithRole(roles: string[]): Promise<Row | null> {
  return (
    (await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id'])
      .where('os_roles.name', 'in', roles)
      .executeTakeFirst()) ?? null);
}

// A logged-in user with no admin role (for the 403 guard test).
async function userWithoutRole(): Promise<Row | null> {
  const rows = await db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_users.id as uid', 'os_roles.name as role'])
    .execute();
  const byUser = new Map<number, Set<string>>();
  for (const r of rows) {
    const s = byUser.get(r.uid) ?? new Set<string>();
    s.add(r.role);
    byUser.set(r.uid, s);
  }
  for (const [id, rs] of byUser) if (![...rs].includes('admin')) return { id };
  return null;
}

function buildApp(user: Row | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerReportRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

describe('T22a report sales routes (fastify inject)', () => {
  it('guards: anon -> 302 /login; non-admin -> 403 No Access.', async () => {
    const anon = buildApp(null);
    const out = await anon.inject({ method: 'GET', url: '/SalesTaxReport' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      const res = await app.inject({ method: 'GET', url: '/SalesTaxReport' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('No Access.');
      await app.close();
    }
  });

  it('/SalesTaxReport renders the procedure rows (defaults: 3 months ago .. today)', async () => {
    const user = await userWithRole(['admin']);
    if (!user) throw new Error('no admin user in DB');
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/SalesTaxReport' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<td>County</td>');
    expect(res.body).toContain('id="salesTable"');
    // Same rows as a direct call of the procedure with the page's own date range.
    const startVal = /name="start"[^>]*value='([^']*)'/.exec(res.body)?.[1];
    const endVal = /name="end"[^>]*value='([^']*)'/.exec(res.body)?.[1];
    if (!startVal || !endVal) throw new Error('date values not found in page');
    // CALL returns [result set, trailing OK packet] to mysql2; the first set is the data.
    const { rows } = await sql`call SalesTaxReport(${startVal},${endVal})`.execute(db);
    const data = (Array.isArray(rows[0]) ? rows[0] : []) as { county: string | null; total: string | null }[];
    for (const r of data) {
      expect(res.body).toContain(`<td>${r.total ?? ''}</td>`);
    }
    // Default start/end inputs land in the datepicker fields.
    expect(res.body).toContain('name="start" type="text" placeholder="" class="datepicker" data-date-format="yyyy-mm-dd" value=\'20');
    await app.close();
  });

  it('/SalesTaxReport with start/end params passes them to the procedure', async () => {
    const user = await userWithRole(['admin']);
    if (!user) throw new Error('no admin user in DB');
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/SalesTaxReport?start=2017-09-20&end=2017-09-30' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("value='2017-09-20'");
    expect(res.body).toContain("value='2017-09-30'");
    await app.close();
  });

  it('/SalesReport and /SalesSnapshotReport -> 500 (SalesReport procedure missing)', async () => {
    const user = await userWithRole(['admin']);
    if (!user) throw new Error('no admin user in DB');
    const app = buildApp(user);
    const a = await app.inject({ method: 'GET', url: '/SalesReport' });
    expect(a.statusCode).toBe(500);
    expect(a.body).toContain('Internal Server Error');
    const b = await app.inject({ method: 'GET', url: '/SalesSnapshotReport' });
    expect(b.statusCode).toBe(500);
    expect(b.body).toContain('Internal Server Error');
    await app.close();
  });
});
