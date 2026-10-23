// T11: TimesheetController (any /timesheet, any /runTimesheet, getTimesheet,
// getTimesheetReport, getTimesheetRangeReport, save/deleteTimesheet) and the
// /staffs resource.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerStaffsRoutes } from '../src/modules/staffs/routes.js';
import { registerTimesheetRoutes } from '../src/modules/timesheet/routes.js';
import { registerViewPlugins } from '../src/view.js';

async function userWithRole(roles: string[]): Promise<{ id: number; company_id: number } | null> {
  return (
    (await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id', 'os_users.company_id'])
      .where('os_roles.name', 'in', roles)
      .executeTakeFirst()) ?? null);
}

function buildApp(user: { id: number } | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerTimesheetRoutes(app);
  registerStaffsRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

describe('T11 timesheet + staffs (fastify inject)', () => {
  it('GET /timesheet: anon -> 302 /login; admin -> 500 (old User::company() fatals)', async () => {
    const anon = buildApp(null);
    const out = await anon.inject({ method: 'GET', url: '/timesheet' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    // The old app's index calls user()->company(), which references the
    // non-existent App\Company, so the page always 500s (reproduced faithfully).
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const page = await app.inject({ method: 'GET', url: '/timesheet' });
    expect(page.statusCode).toBe(500);
    expect(page.body).toContain('Internal Server Error');
    await app.close();
  });

  it('GET /runTimesheet: admin -> report page; non-admin -> 403', async () => {
    const nonAdmin = await db
      .selectFrom('os_users')
      .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
      .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
      .select(['os_users.id'])
      .where('os_roles.name', '=', 'supplier')
      .executeTakeFirst();
    if (nonAdmin) {
      const app = buildApp(nonAdmin);
      const res = await app.inject({ method: 'GET', url: '/runTimesheet' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('No Access.');
      await app.close();
    }
    const admin = await userWithRole(['admin']);
    if (admin) {
      const app = buildApp(admin);
      const res = await app.inject({ method: 'GET', url: '/runTimesheet' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('id="reporttable"');
      await app.close();
    }
  });

  it('GET /getTimesheet?staff=Alex -> JSON rows with a numeric `hours`', async () => {
    const staff = (await db.selectFrom('os_timesheet').select('staff').limit(1).execute())[0];
    if (!staff) throw new Error('no timesheet rows in DB');
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const res = await app.inject({ method: 'GET', url: `/getTimesheet?staff=${staff.staff}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    for (const row of body) expect(typeof row.hours).toBe('number');
    await app.close();
  });

  it('GET /getTimesheetReport + /getTimesheetRangeReport -> JSON arrays', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const a = await app.inject({ method: 'GET', url: '/getTimesheetReport?staff=nobody' });
    expect(a.statusCode).toBe(200);
    expect(JSON.parse(a.body)).toEqual([]);
    const b = await app.inject({ method: 'GET', url: '/getTimesheetRangeReport?start=2020-01-01&end=2020-01-02' });
    expect(b.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(b.body))).toBe(true);
    await app.close();
  });

  it('POST /saveTimesheet inserts, then /deleteTimesheet removes (cleaned up)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const staff = `t11-${Date.now()}`;
    const app = buildApp(admin);
    const saved = await app.inject({
      method: 'POST',
      url: '/saveTimesheet',
      payload: { staff, workdate: '2020-01-01', start: '9:00 AM', end: '5:00 PM', lunchstart: '12:00 PM', lunchend: '12:30 PM' },
    });
    expect(saved.statusCode).toBe(200);
    const savedRow = JSON.parse(saved.body);
    expect(savedRow.id).toBeGreaterThan(0);
    expect(savedRow.staff).toBe(staff);
    const del = await app.inject({ method: 'POST', url: '/deleteTimesheet', payload: { timesheetId: String(savedRow.id) } });
    expect(del.statusCode).toBe(200);
    expect(del.body).toBe('1');
    const gone = await db.selectFrom('os_timesheet').select('id').where('id', '=', savedRow.id).executeTakeFirst();
    expect(gone).toBeFalsy();
    // empty id -> 'failed'
    const fail = await app.inject({ method: 'POST', url: '/deleteTimesheet', payload: { timesheetId: '' } });
    expect(fail.body).toBe('failed');
    await app.close();
  });

  it('GET /staffs (admin) renders the table; /staffs/create renders the form', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const page = await app.inject({ method: 'GET', url: '/staffs' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<th>Name</th>');
    const create = await app.inject({ method: 'GET', url: '/staffs/create' });
    expect(create.statusCode).toBe(200);
    expect(create.body).toContain('name="name"');
    expect(create.body).toContain('Create New staff');
    await app.close();
  });

  it('GET /staffs/:id (show) and /staffs/:id/edit render for a real staff', async () => {
    const staff = (await db.selectFrom('os_staffs').select('id').limit(1).execute())[0];
    const admin = await userWithRole(['admin']);
    if (!staff || !admin) throw new Error('no staff/admin in DB');
    const app = buildApp(admin);
    const show = await app.inject({ method: 'GET', url: `/staffs/${staff.id}` });
    expect(show.statusCode).toBe(200);
    expect(show.body).toContain('<th>Pin</th>');
    const edit = await app.inject({ method: 'GET', url: `/staffs/${staff.id}/edit` });
    expect(edit.statusCode).toBe(200);
    expect(edit.body).toContain('Edit staff');
    // missing id -> 404
    const missing = await app.inject({ method: 'GET', url: '/staffs/99999999' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('POST /staffs with empty name -> 302 back with flashed errors (no row written)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const before = (await db.selectFrom('os_staffs').selectAll().execute()).length;
    const app = buildApp(admin);
    const res = await app.inject({ method: 'POST', url: '/staffs', payload: { name: '', company_id: String(admin.company_id) } });
    expect(res.statusCode).toBe(302);
    const after = (await db.selectFrom('os_staffs').selectAll().execute()).length;
    expect(after).toBe(before);
    await app.close();
  });
});
