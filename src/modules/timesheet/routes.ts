// TimesheetController (routes/web.php:36-42, all web + role:admin).
// The old controller has no $hidden/$appends on the Timesheet model, so a
// serialised model is every DB column; GetTimesheet appends a computed `hours`.

import type { FastifyInstance } from 'fastify';
import { db, nowDb, sql } from '../../db.js';
import { input } from '../../http.js';
import { any, route } from '../../router.js';
import { render, sendServer500 } from '../../view.js';

// PHP strtotime("YYYY-MM-DD h:MM AM/PM"). Only differences between two such
// values are ever used, so a UTC epoch (no local DST) is exact.
function strToTime(dateStr: string | Date, timeStr: string | Date | null): number {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = String(timeStr ?? '').trim().toUpperCase();
  const match = t.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/);
  if (!match) {
    // PHP strtotime("YYYY-MM-DD ") (null/empty time) = that date at 00:00:00.
    return Date.UTC(y, m - 1, d, 0, 0, 0) / 1000;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3];
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return Date.UTC(y, m - 1, d, hour, minute, 0) / 1000;
}

// Select the row and serialise it the way Eloquent does (all columns, in order),
// mirroring what the old app returned from `response()->json($model)`.
async function fetchTimesheetRow(id: number): Promise<Record<string, unknown>> {
  const row = await db
    .selectFrom('os_timesheet')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new Error('timesheet row vanished after save');
  return row as Record<string, unknown>;
}

export function registerTimesheetRoutes(app: FastifyInstance): void {
  const middleware = ['web', 'role:admin'];

  // Route::any('/timesheet') -> index. The old controller's index calls
  // $request->user()->company(); User::company() (namespace App) references
  // `Company` which resolves to the non-existent App\Company (the model is
  // App\Models\Company), so the page always fatals with a 500 (see NOTES.md).
  // Reproduced via sendServer500, the same pattern T10 uses for missing methods.
  any(app, {
    path: '/timesheet',
    name: 'timesheet',
    middleware,
    handler: async (req, reply) => {
      await sendServer500(req, reply);
    },
  });

  // Route::any('/runTimesheet') -> RunReport (plain page, no logic).
  any(app, {
    path: '/runTimesheet',
    name: 'runTimesheet',
    middleware,
    handler: async (req, reply) => {
      await render(req, reply, 'timesheet/run');
    },
  });

  route(app, {
    verb: 'get',
    path: '/getTimesheetReport',
    name: 'getTimesheetReport',
    middleware,
    handler: async (req, reply) => {
      const staff = input(req, 'staff');
      // Raw SQL is not os_-prefixed by Laravel — copied unchanged from the PHP.
      const { rows } = await sql`select staff,YEAR(workdate) year,MONTH(workdate) month, sum(time_to_sec(timediff(STR_TO_DATE(CONCAT(workdate,' ',end),'%Y-%m-%d %h:%i %p') , STR_TO_DATE(CONCAT(workdate,' ',start),'%Y-%m-%d %h:%i %p') ))/3600 - time_to_sec(timediff(STR_TO_DATE(CONCAT(workdate,' ',lunchend),'%Y-%m-%d %h:%i %p') , STR_TO_DATE(CONCAT(workdate,' ',lunchstart),'%Y-%m-%d %h:%i %p') ))/3600 ) as workhours from os_timesheet where staff = ${staff} group by staff,YEAR(workdate),MONTH(workdate) order by YEAR(workdate) desc ,MONTH(workdate) desc`.execute(db);
      reply.send(rows);
    },
  });

  route(app, {
    verb: 'get',
    path: '/getTimesheetRangeReport',
    name: 'getTimesheetRangeReport',
    middleware,
    handler: async (req, reply) => {
      const start = input(req, 'start');
      const end = input(req, 'end');
      const { rows } = await sql`select staff,sum(time_to_sec(timediff(STR_TO_DATE(CONCAT(workdate,' ',end),'%Y-%m-%d %h:%i %p') , STR_TO_DATE(CONCAT(workdate,' ',start),'%Y-%m-%d %h:%i %p') ))/3600 - time_to_sec(timediff(STR_TO_DATE(CONCAT(workdate,' ',lunchend),'%Y-%m-%d %h:%i %p') , STR_TO_DATE(CONCAT(workdate,' ',lunchstart),'%Y-%m-%d %h:%i %p') ))/3600 ) as workhours from os_timesheet where  workdate BETWEEN ${start} AND ${end} group by staff `.execute(db);
      reply.send(rows);
    },
  });

  route(app, {
    verb: 'get',
    path: '/getTimesheet',
    name: 'getTimesheet',
    middleware,
    handler: async (req, reply) => {
      const staff = input(req, 'staff');
      const timesheetId = input(req, 'timesheetId');
      let rows =
        timesheetId === '' || timesheetId === null
          ? await db.selectFrom('os_timesheet').selectAll().where('staff', '=', String(staff)).orderBy('workdate', 'desc').limit(45).execute()
          : await db.selectFrom('os_timesheet').selectAll().where('id', '=', Number(timesheetId)).orderBy('workdate', 'desc').limit(1).execute();
      const ts = rows.map((t) => {
        const start = strToTime(t.workdate, t.start);
        const end = strToTime(t.workdate, t.end);
        let hours = (end - start) / (60 * 60);
        const ls = strToTime(t.workdate, t.lunchstart);
        const le = strToTime(t.workdate, t.lunchend);
        hours -= (le - ls) / (60 * 60);
        // SAFETY: t is the full os_timesheet row; spread it into a plain object so the
        // computed `hours` attribute can be appended (matches Eloquent's $t->hours).
        return { ...(t as unknown as Record<string, unknown>), hours };
      });
      reply.send(ts);
    },
  });

  route(app, {
    verb: 'post',
    path: '/saveTimesheet',
    name: 'saveTimesheet',
    middleware,
    handler: async (req, reply) => {
      const timesheetId = input(req, 'timesheetId');
      const staff = input(req, 'staff');
      const workdate = input(req, 'workdate');
      const start = input(req, 'start');
      const end = input(req, 'end');
      const lunchstart = input(req, 'lunchstart');
      const lunchend = input(req, 'lunchend');

      let id: number | null = null;
      if (timesheetId !== '' && timesheetId !== null) {
        const existing = await db.selectFrom('os_timesheet').select('id').where('id', '=', Number(timesheetId)).executeTakeFirst();
        if (!existing) return reply.code(404).send(''); // findOrFail
        id = existing.id;
      }
      const ts = nowDb();
      // SAFETY: Kysely types these columns as Date; the app stores the
      // 'YYYY-MM-DD HH:mm:ss' string (mysql2 stores it unchanged).
      const workdateVal = String(workdate) as unknown as Date;
      // SAFETY: ts is the nowDb() 'YYYY-MM-DD HH:mm:ss' string, not a Date.
      const tsVal = ts as unknown as Date;
      if (id === null) {
        const result = await db
          .insertInto('os_timesheet')
          .values({
            staff: String(staff),
            workdate: workdateVal,
            start: String(start),
            end: String(end),
            lunchstart: lunchstart === null ? null : String(lunchstart),
            lunchend: lunchend === null ? null : String(lunchend),
            created_at: tsVal,
            updated_at: tsVal,
          })
          .executeTakeFirst();
        id = Number(result?.insertId ?? 0);
      } else {
        await db
          .updateTable('os_timesheet')
          .set({
            staff: String(staff),
            workdate: workdateVal,
            start: String(start),
            end: String(end),
            lunchstart: lunchstart === null ? null : String(lunchstart),
            lunchend: lunchend === null ? null : String(lunchend),
            updated_at: tsVal,
          })
          .where('id', '=', id)
          .execute();
      }
      reply.send(await fetchTimesheetRow(id));
    },
  });

  route(app, {
    verb: 'post',
    path: '/deleteTimesheet',
    name: 'deleteTimesheet',
    middleware,
    handler: async (req, reply) => {
      const timesheetId = input(req, 'timesheetId');
      if (timesheetId !== '' && timesheetId !== null) {
        // Eloquent ->delete() returns the affected-row count as an int (1 or 0).
        const result = await db.deleteFrom('os_timesheet').where('id', '=', Number(timesheetId)).execute();
        reply.send(Number(result[0]?.numDeletedRows ?? 0));
      }
      reply.type('text/html; charset=UTF-8').send('failed');
    },
  });
}
