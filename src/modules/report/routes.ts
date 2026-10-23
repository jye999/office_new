// ReportController (routes/web.php:52-54, web + role:admin).
//
// The `SalesReport` stored procedure does not exist in the shared DB (only
// SalesTaxReport does — verified via information_schema and live on :6999),
// so /SalesReport and /SalesSnapshotReport fatal on their very first
// DB::select('call SalesReport(?,?)') -> 500 in the old app. Reproduced via
// sendServer500 (T10/T11/T15 pattern); the dead aggregation code after that
// line is not ported.

import type { FastifyInstance } from 'fastify';
import { db, sql } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { date, render, sendServer500 } from '../../view.js';

// PHP: date('Y-m-d', strtotime(date('Y-m-d H:i:s') . ' -3 months')) — the day
// of month rolls over (Jan 31 - 3 months -> Oct 31 is fine; Mar 31 - 1 month
// -> Feb 31 = Mar 3), which Date.UTC month arithmetic reproduces exactly.
function dateThreeMonthsAgo(): string {
  const [y, m, d] = date('Y-m-d').split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 - 3, 1 + (d - 1)));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export function registerReportRoutes(app: FastifyInstance): void {
  const middleware = ['web', 'role:admin'];

  // Route::get('/SalesReport') -> Sales. `call SalesReport(?,?)` throws
  // (procedure missing) -> 500, always.
  route(app, {
    verb: 'get',
    path: '/SalesReport',
    name: 'SalesReport',
    middleware,
    handler: async (req, reply) => {
      await sendServer500(req, reply);
    },
  });

  // Route::get('/SalesTaxReport') -> SalesTax.
  route(app, {
    verb: 'get',
    path: '/SalesTaxReport',
    name: 'SalesTaxReport',
    middleware,
    handler: async (req, reply) => {
      const start = input(req, 'start') ?? dateThreeMonthsAgo();
      const end = input(req, 'end') ?? date('Y-m-d');
      // Raw SQL (DB::select) is not os_-prefixed by Laravel — copied unchanged.
      const { rows } = await sql`call SalesTaxReport(${start},${end})`.execute(db);
      // mysql2 returns [procedure result set, trailing OK packet] for CALL;
      // PHP's PDO only sees the result set.
      const sales = (Array.isArray(rows[0]) ? rows[0] : []) as Record<string, unknown>[];
      await render(req, reply, 'report/salestax', { sales, start, end });
    },
  });

  // Route::get('/SalesSnapshotReport') -> SalesSnapshot. First statement is
  // `DB::select('call SalesReport(?,?)')` -> 500, always (procedure missing).
  route(app, {
    verb: 'get',
    path: '/SalesSnapshotReport',
    name: 'SalesSnapshotReport',
    middleware,
    handler: async (req, reply) => {
      await sendServer500(req, reply);
    },
  });
}
