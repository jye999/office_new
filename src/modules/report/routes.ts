// ReportController (routes/web.php:52-54, web + role:admin).
//
// `call SalesReport(?,?)` / `SalesTaxReport(?,?)` are production stored procedures
// (absent from the dev DB — tests mock the CALL). Raw DB::select is not os_-prefixed;
// Eloquent (SalesSummary) is, so it is `os_SalesSummary` here.

import type { FastifyInstance } from 'fastify';
import { db, sql } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { date, render, strtotime } from '../../view.js';

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

// mysql2 returns [procedure result set, trailing OK packet] for CALL;
// PHP's PDO only sees the result set.
async function callSalesReport(start: string, end: string): Promise<Record<string, unknown>[]> {
  const { rows } = await sql`call SalesReport(${start},${end})`.execute(db);
  return (Array.isArray(rows[0]) ? rows[0] : []) as Record<string, unknown>[];
}

// PHP strtotime()-derived dates are all wall-clock calendar math; Date.UTC
// normalises day overflow (Feb 29 - 1 year -> Mar 1) exactly like PHP.
function ymd(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

type SummaryRow = { Channel: string; Fulfillment: string; Price: string };

// SalesSummary::where('Date','>=',$from)[->where('Date','<',$to)]->selectRaw(...)->groupBy('Channel','Fulfillment').
// The full select list is kept so MySQL returns groups in the same order as the old app.
async function salesSummary(from: string, to: string | null): Promise<SummaryRow[]> {
  const upper = to === null ? sql`` : sql`and \`Date\` < ${to}`;
  const { rows } = await sql<SummaryRow>`select Channel, Fulfillment, SUM(\`Order\`) as \`Order\`, SUM(QTY) as QTY, SUM(Price) as Price, SUM(Tax) as Tax, SUM(Shipping) as Shipping
    from os_SalesSummary where \`Date\` >= ${from} ${upper} group by Channel, Fulfillment`.execute(db);
  return rows;
}

// The date()/strtotime() range strings of ReportController@SalesSnapshot for the app-timezone day y-m-d.
export function snapshotDates(y: number, m: number, d: number) {
  // PHP's "last week" (relative text + "week") snaps to Monday of the previous ISO week and keeps the time of day;
  // "last week +6 days" is therefore that week's Sunday.
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const lastweekMonday = d + (dow === 0 ? -6 : 1 - dow) - 7;
  return {
    thisyearFirstday: ymd(y, 1, 1),
    todayStart: `${ymd(y, m, d)} 00:00:00`,
    todayEnd: `${ymd(y, m, d)} 23:59:59`,
    yesterdayStart: `${ymd(y, m, d - 1)} 00:00:00`,
    yesterdayEnd: `${ymd(y, m, d - 1)} 23:59:59`,
    lastweekStart: `${ymd(y, m, lastweekMonday)} 00:00:00`,
    lastweekEnd: `${ymd(y, m, lastweekMonday + 6)} 23:59:59`,
    thismonthStart: `${ymd(y, m, 1)} 00:00:00`,
    lastyearFirstday: `${ymd(y - 1, 1, 1)} 00:00:00`,
    lastyearStart: `${ymd(y - 1, m, 1)} 00:00:00`,
    lastyearToday: `${ymd(y - 1, m, d)} 00:00:00`,
    lastyearTodayEnd: `${ymd(y - 1, m, d)} 23:59:59`,
    lastyearMonthEnd: `${ymd(y - 1, m + 1, 0)} 23:59:59`,
  };
}

// ReportController@SalesSnapshot. Orders/qty accumulations in the PHP are never rendered, so only prices are kept.
// `day` is the report's "today" (y-m-d, app timezone); the 03:15 email passes yesterday so its Today column is a full day.
export async function salesSnapshot(day: string = date('Y-m-d')) {
  const [y, m, d] = day.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const {
    thisyearFirstday, todayStart, todayEnd, yesterdayStart, yesterdayEnd, lastweekStart, lastweekEnd,
    thismonthStart, lastyearFirstday, lastyearStart, lastyearToday, lastyearTodayEnd, lastyearMonthEnd,
  } = snapshotDates(y, m, d);

  const sales = await callSalesReport(todayStart, todayEnd);
  const ytd = await salesSummary(thisyearFirstday, null);
  const yesterday = await salesSummary(yesterdayStart, yesterdayEnd);
  const lastweek = await salesSummary(lastweekStart, lastweekEnd);
  const thismonth = await salesSummary(thismonthStart, todayStart);
  const lastytd = await salesSummary(lastyearFirstday, lastyearTodayEnd);
  const lastyearTodate = await salesSummary(lastyearStart, lastyearTodayEnd);
  const lastyearTodaySales = await salesSummary(lastyearToday, lastyearTodayEnd);
  const lastyearMonth = await salesSummary(lastyearStart, lastyearMonthEnd);

  const data: Record<string, string | number | null>[] = ytd.map((s) => ({ Channel: s.Channel, Fulfillment: s.Fulfillment }));
  const total: Record<string, number> = {};
  const addPrices = (key: string, rows: SummaryRow[], prediction = false) => {
    total[key] = 0;
    if (prediction) total.thismonth_prediction = 0;
    for (const s of rows) {
      for (const row of data) {
        if (s.Channel !== row.Channel || s.Fulfillment !== row.Fulfillment) continue;
        row[`${key}_price`] = Number(s.Price);
        total[key] += Number(s.Price);
        if (prediction) {
          row.thismonth_prediction_price = (Number(s.Price) / d) * daysInMonth;
          total.thismonth_prediction += (Number(s.Price) / d) * daysInMonth;
        }
      }
    }
  };
  addPrices('ytd', ytd);
  addPrices('lastytd', lastytd);
  addPrices('lastyear_todate', lastyearTodate);
  addPrices('lastyear_today', lastyearTodaySales);
  addPrices('lastyear_month', lastyearMonth);
  addPrices('thismonth', thismonth, true);
  addPrices('lastweek', lastweek);
  addPrices('yesterday', yesterday);

  total.today = 0;
  for (const s of sales) {
    for (const row of data) {
      if (s.channel !== row.Channel || s.fulfillment !== row.Fulfillment) continue;
      const price = Number(s.price ?? 0);
      row.today_price = s.price === null ? null : price;
      total.today += price;
      if (row.thismonth_price != null) row.thismonth_price = Number(row.thismonth_price) + price;
      total.thismonth += price;
      if (row.ytd_price != null) row.ytd_price = Number(row.ytd_price) + price;
      total.ytd += price;
    }
  }
  return { data, total, today_start: todayStart, today_end: todayEnd, lastyear_today: lastyearToday };
}

export function registerReportRoutes(app: FastifyInstance): void {
  const middleware = ['web', 'role:admin'];

  // Route::get('/SalesReport') -> Sales.
  route(app, {
    verb: 'get',
    path: '/SalesReport',
    name: 'SalesReport',
    middleware,
    handler: async (req, reply) => {
      // $request->has(): this Laravel treats an empty/blank value as absent.
      const given = (key: string) => {
        const v = input<string>(req, key);
        return v !== null && String(v).trim() !== '' ? v : null;
      };
      const start = given('start') ?? dateSevenDaysAgo();
      const end = given('end') ?? date('Y-m-d');
      const sales = await callSalesReport(start, end);
      await render(req, reply, 'report/sales', { sales, start, end });
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
      const sales = (Array.isArray(rows[0]) ? rows[0] : []) as Record<string, unknown>[];
      await render(req, reply, 'report/salestax', { sales, start, end });
    },
  });

  // Route::get('/SalesSnapshotReport') -> SalesSnapshot.
  route(app, {
    verb: 'get',
    path: '/SalesSnapshotReport',
    name: 'SalesSnapshotReport',
    middleware,
    handler: async (req, reply) => {
      await render(req, reply, 'report/salessnapshot', await salesSnapshot());
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
