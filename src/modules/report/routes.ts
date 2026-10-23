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
import { date, render, sendServer500, strtotime } from '../../view.js';

// Blade inline <?php switch($s->store) ?> from report/productsales.blade.php.
const STORE_LABELS: Record<string, string> = {
  A: '1 - Amazon',
  E: '7 - eBay - Retail',
  R: '8 - eBay - Floral Supply',
  S: '3 - Shopify',
  T: '4 - Etsy - Retail 1',
  H: '9 - Houzz',
  W: '2 - Walmart',
  D: '10 - Walmart Ddropship',
  T2: '6 - Etsy - Floral Supply',
  T3: '5 - Etsy - Retail 2',
};

// PHP: date('Y-m-d', strtotime(date('Y-m-d H:i:s') . ' -3 months')) — the day
// of month rolls over (Jan 31 - 3 months -> Oct 31 is fine; Mar 31 - 1 month
// -> Feb 31 = Mar 3), which Date.UTC month arithmetic reproduces exactly.
function dateThreeMonthsAgo(): string {
  const [y, m, d] = date('Y-m-d').split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 - 3, 1 + (d - 1)));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// PHP: date('Y-m-d', strtotime('-7 days')) — wall-clock day arithmetic in the
// app timezone (date('Y-m-d') already gives that wall clock).
function dateSevenDaysAgo(): string {
  const [y, m, d] = date('Y-m-d').split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 7));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// getLowInventoryRows(): raw SQL is not os_-prefixed; PHP builds the table
// names from getTablePrefix() ('os_') + 'products' / 'product_locations'.
async function lowInventoryRows(): Promise<{ sku: string; total_qty: string | number }[]> {
  const { rows } = await sql.raw(`
    SELECT op.sku, SUM(opl.qty) AS total_qty
    FROM \`os_products\` op
    INNER JOIN \`os_product_locations\` opl ON op.id = opl.product_id
    WHERE op.sku IS NOT NULL AND op.sku != '' and op.status = 'Active'
    GROUP BY op.id, op.sku
    HAVING COALESCE(SUM(opl.qty), 0) < CASE
        WHEN UPPER(LEFT(TRIM(op.sku), 1)) IN ('R', 'C', 'H', 'G') THEN 100
        ELSE 10
    END
    ORDER BY op.sku
  `).execute(db);
  return rows as { sku: string; total_qty: string | number }[];
}

// PHP 7.4 fputcsv: quote the field when it contains a space/tab/comma/quote
// or line break (verified against the old app's PHP 7.4 runtime); embedded
// quotes are doubled.
function csvField(value: unknown): string {
  const s = String(value);
  return /[\s",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// (int) cast of the DECIMAL string SUM() returns (0 on non-numeric).
function intCsv(value: string | number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function receivingHandler(req: Parameters<Parameters<typeof route>[1]['handler']>[0], reply: Parameters<Parameters<typeof route>[1]['handler']>[1]): Promise<void> {
  const defaultStart = dateSevenDaysAgo();
  const defaultEnd = date('Y-m-d');
  const startInput = String(input(req, 'start') ?? defaultStart).trim();
  const endInput = String(input(req, 'end') ?? defaultEnd).trim();
  // PHP: strtotime() === false -> keep the default; valid dates never give 0.
  const ts = strtotime(startInput);
  let start = ts ? date('Y-m-d', ts) : defaultStart;
  const te = strtotime(endInput);
  let end = te ? date('Y-m-d', te) : defaultEnd;
  if (start > end) [start, end] = [end, start];
  const status = String(input(req, 'status') ?? 'all').trim().toLowerCase();
  const VALID_STATUSES = ['all', 'received', 'putaway', 'void']; // PdaReceivingLine::statuses()
  const st = VALID_STATUSES.includes(status) ? status : 'all';
  // Eloquent whereDate() compiles to date(received_date) >=/<= '...';
  // received_date is a DATE column, so the plain comparison is identical.
  // SAFETY: start/end/st are the defaults, 'Y-m-d' strings, or a fixed
  // status whitelist — all passed as bound parameters.
  const rows = (st === 'all'
    ? await sql`select * from os_pda_receiving_lines where received_date >= ${start} and received_date <= ${end} order by id desc`.execute(db)
    : await sql`select * from os_pda_receiving_lines where received_date >= ${start} and received_date <= ${end} and status = ${st} order by id desc`.execute(db)
  ).rows as {
    received_date: string;
    sku: string;
    carton: string | null;
    per_carton: number | null;
    qty: number;
    status: string;
    put_away_date: string | null;
  }[];
  await render(req, reply, 'report/receiving', {
    rows,
    start,
    end,
    status: st,
    total_lines: rows.length,
    total_qty: rows.reduce((n, r) => n + Number(r.qty), 0),
  });
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

  // Route::get('/ProductSalesReport') -> ProductSales.
  route(app, {
    verb: 'get',
    path: '/ProductSalesReport',
    name: 'ProductSalesReport',
    middleware,
    handler: async (req, reply) => {
      const keyword = String(input(req, 'keyword') ?? '');
      let start = dateThreeMonthsAgo();
      let end = date('Y-m-d');
      const s = input(req, 'start');
      if (s !== null) start = String(s);
      const e = input(req, 'end');
      if (e !== null) end = String(e);
      // Raw SQL (DB::select) is not os_-prefixed and interpolates the input
      // verbatim (injection quirk kept for parity — quotes 500 in both apps).
      const { rows: sales } = await sql.raw(
        `select ogo.store, ogod.name, sum(ogod.qty) as qty, sum(ogod.price * ogod.qty) as total from os_grant_order ogo inner join os_grant_orderdetail ogod on ogo.orderId = ogod.orderId where ogo.created_at between '${start}' and '${end}' and ogod.name like '%${keyword}%' group by ogod.name,ogo.store order by sum(ogod.qty) desc`,
      ).execute(db);
      // The blade's inline <?php switch($s->store) ?> label map, computed here.
      const withLabels = (sales as Record<string, unknown>[]).map((r) => ({
        ...r,
        store_label: STORE_LABELS[String(r.store ?? '')] ?? '',
      }));
      await render(req, reply, 'report/productsales', { sales: withLabels, start, end, keyword });
    },
  });

  // Route::get('/LowInventoryReport') -> LowInventory.
  route(app, {
    verb: 'get',
    path: '/LowInventoryReport',
    name: 'LowInventoryReport',
    middleware,
    handler: async (req, reply) => {
      const rows = await lowInventoryRows();
      await render(req, reply, 'report/lowinventory', { rows });
    },
  });

  // Route::get('/LowInventoryReport/export') -> LowInventoryExport (CSV stream).
  route(app, {
    verb: 'get',
    path: '/LowInventoryReport/export',
    name: 'LowInventoryReportExport',
    middleware,
    handler: async (req, reply) => {
      const rows = await lowInventoryRows();
      const filename = `low-inventory-${date('Y-m-d')}.csv`;
      reply
        .header('Content-Type', 'text/csv; charset=UTF-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Pragma', 'no-cache')
        .header('Cache-Control', 'must-revalidate, post-check=0, pre-check=0')
        .header('Expires', '0');
      // BOM + fputcsv rows (PHP 7.4: \n line endings).
      let body = '\uFEFF';
      body += `${csvField('SKU')},${csvField('Total QTY')}\n`;
      for (const row of rows) body += `${csvField(row.sku)},${intCsv(row.total_qty)}\n`;
      reply.send(body);
    },
  });

  // Route::get('/ReceivingReport') -> Receiving.
  route(app, {
    verb: 'get',
    path: '/ReceivingReport',
    name: 'ReceivingReport',
    middleware,
    handler: receivingHandler,
  });

  // Route::get('/CodeGeneratorReport') -> CodeGenerator (roles differ).
  route(app, {
    verb: 'get',
    path: '/CodeGeneratorReport',
    name: 'CodeGeneratorReport',
    middleware: ['web', 'role:admin,user,remote'],
    handler: async (req, reply) => {
      await render(req, reply, 'report/codegenerator'); // static view, no data
    },
  });
}
