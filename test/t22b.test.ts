// T22b: ReportController product-sales / low-inventory / receiving /
// code-generator routes (routes/web.php:55-58, 474).

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { describe, expect, it } from 'vitest';
import { db, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { registerReportRoutes } from '../src/modules/report/routes.js';
import { date, registerViewPlugins } from '../src/view.js';

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

// Mirrors e() (double_encode=false): only named entities decode; numeric refs pass through.
function htmlEsc(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&(?!#(\d+|x[0-9a-f]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

// Same aggregation as the route's raw SQL (keyword-less, default range).
async function lowInventoryRows(): Promise<{ sku: string; total_qty: string }[]> {
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
  return rows as { sku: string; total_qty: string }[];
}

describe('T22b report routes (fastify inject)', () => {
  it('guards: anon -> 302 /login; non-admin -> 403; non-admin can still open CodeGenerator', async () => {
    const anon = buildApp(null);
    const out = await anon.inject({ method: 'GET', url: '/ProductSalesReport' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const denied = await userWithoutRole();
    if (denied) {
      const app = buildApp(denied);
      const res = await app.inject({ method: 'GET', url: '/ReceivingReport' });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('No Access.');
      // role:admin,user,remote — a 'user'/'remote' role user passes.
      const roles = (
        await db
          .selectFrom('os_user_has_roles')
          .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
          .where('os_user_has_roles.user_id', '=', denied.id)
          .select(['os_roles.name'])
          .execute()
      ).map((r) => r.name);
      if (roles.includes('user') || roles.includes('remote')) {
        const cg = await app.inject({ method: 'GET', url: '/CodeGeneratorReport' });
        expect(cg.statusCode).toBe(200);
      }
      await app.close();
    }
  });

  it('/ProductSalesReport renders the sales table (keyword/start/end echoed)', async () => {
    const user = await userWithRole(['admin']);
    if (!user) throw new Error('no admin user in DB');
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/ProductSalesReport?keyword=flower&start=2024-01-01&end=2024-01-31' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="salesTable"');
    expect(res.body).toContain("value='flower'");
    expect(res.body).toContain("value='2024-01-01'");
    expect(res.body).toContain("value='2024-01-31'");
    // Rows cross-checked against the same raw SQL.
    const { rows: salesRows } = await sql.raw(
      `select ogo.store, ogod.name, sum(ogod.qty) as qty, sum(ogod.price * ogod.qty) as total from os_grant_order ogo inner join os_grant_orderdetail ogod on ogo.orderId = ogod.orderId where ogo.created_at between '2024-01-01' and '2024-01-31' and ogod.name like '%flower%' group by ogod.name,ogo.store order by sum(ogod.qty) desc`,
    ).execute(db);
    const salesList = salesRows as unknown as { name: string }[];
    // Scope to the report table: layout includes also contain <tr>s.
    // Scope to the report table: layout includes also contain <table>s.
    const tableStart = res.body.indexOf('<table id="salesTable"');
    const table = res.body.slice(tableStart, res.body.indexOf('</table>', tableStart));
    const bodyRows = table.match(/<tr>/g) ?? [];
    // First <tr> is the header; data rows match the SQL row count.
    expect(bodyRows.length - 1).toBe(salesList.length);
    for (const r of salesList) {
      // {{ s.name }} is autoescaped: & < > " ' -> named entities
      expect(res.body).toContain(htmlEsc(r.name));
    }
    await app.close();
  });

  it('/LowInventoryReport lists the sub-threshold SKUs and the export button', async () => {
    const user = await userWithRole(['admin']);
    if (!user) throw new Error('no admin user in DB');
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/LowInventoryReport' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="lowInventoryTable"');
    expect(res.body).toContain('href="http://localhost:7000/LowInventoryReport/export"');
    const rows = await lowInventoryRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(res.body).toContain(`<td>${htmlEsc(r.sku)}</td>`);
      expect(res.body).toContain(`<td>${Math.trunc(Number(r.total_qty))}</td>`);
    }
    await app.close();
  });

  it('/LowInventoryReport/export streams the CSV (BOM, header, rows, headers)', async () => {
    const user = await userWithRole(['admin']);
    if (!user) throw new Error('no admin user in DB');
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/LowInventoryReport/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=UTF-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="low-inventory-${date('Y-m-d')}.csv"`);
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.headers['cache-control']).toBe('must-revalidate, post-check=0, pre-check=0');
    expect(res.headers['expires']).toBe('0');
    const rows = await lowInventoryRows();
    // PHP 7.4 fputcsv quoting (space/tab/comma/quote trigger it).
    const csv = (v: string) => /[\s",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    let body = '\uFEFF';
    body += `${csv('SKU')},${csv('Total QTY')}\n`;
    for (const r of rows) body += `${csv(r.sku)},${csv(String(Math.trunc(Number(r.total_qty))))}\n`;
    expect(res.body).toBe(body);
    await app.close();
  });

  it('/ReceivingReport renders rows for the default 7-day range; status filter narrows', async () => {
    const user = await userWithRole(['admin']);
    if (!user) throw new Error('no admin user in DB');
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/ReceivingReport' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h2>Receiving Report</h2>');
    expect(res.body).toContain('<strong>Total Lines:</strong>');
    // Cross-check: direct query over the same 7-day window (default = last 7 days incl. today).
    const [y, m, d] = date('Y-m-d').split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, d - 7));
    const p = (n: number) => String(n).padStart(2, '0');
    const startStr = `${start.getUTCFullYear()}-${p(start.getUTCMonth() + 1)}-${p(start.getUTCDate())}`;
    const { rows: receivingRows } = await sql
      `select * from os_pda_receiving_lines where received_date >= ${startStr} and received_date <= ${date('Y-m-d')} order by id desc`
      .execute(db);
    const receivingList = receivingRows as unknown as { sku: string }[];
    // Scope to the report table: layout includes also contain <tr><td>s.
    const tableStart = res.body.indexOf('<table class="table table-bordered table-condensed">');
    const table = res.body.slice(tableStart, res.body.indexOf('</table>', tableStart));
    const dataRows = (table.match(/<tr>\s*<td>/g) ?? []).length;
    expect(dataRows).toBe(receivingList.length);
    for (const r of receivingList) {
      expect(res.body).toContain(`<td>${htmlEsc(String(r.sku))}</td>`);
    }
    // Status filter: a fixed status returns a subset; an invalid one falls back to all.
    const voidRes = await app.inject({ method: 'GET', url: '/ReceivingReport?status=void' });
    expect(voidRes.statusCode).toBe(200);
    expect(voidRes.body).toContain('<option value="void" selected>void</option>');
    const { rows: voidRows } = await sql
      `select * from os_pda_receiving_lines where received_date >= ${startStr} and received_date <= ${date('Y-m-d')} and status = 'void' order by id desc`
      .execute(db);
    const voidStart = voidRes.body.indexOf('<table class="table table-bordered table-condensed">');
    const voidTable = voidRes.body.slice(voidStart, voidRes.body.indexOf('</table>', voidStart));
    expect((voidTable.match(/<tr>\s*<td>/g) ?? []).length).toBe(voidRows.length);
    const bad = await app.inject({ method: 'GET', url: '/ReceivingReport?status=bogus' });
    expect(bad.statusCode).toBe(200);
    expect(bad.body).toContain('<option value="all" selected>all</option>');
    // Garbage dates fall back to the defaults.
    const garbage = await app.inject({ method: 'GET', url: '/ReceivingReport?start=nope&end=nada' });
    expect(garbage.statusCode).toBe(200);
    expect(garbage.body).toContain(`value="${startStr}"`);
    expect(garbage.body).toContain(`value="${date('Y-m-d')}"`);
    await app.close();
  });

  it('/CodeGeneratorReport renders the generator page', async () => {
    const user = await userWithRole(['admin']);
    if (!user) throw new Error('no admin user in DB');
    const app = buildApp(user);
    const res = await app.inject({ method: 'GET', url: '/CodeGeneratorReport' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Barcode / QR Code Generator');
    expect(res.body).toContain('id="raw_values"');
    expect(res.body).toContain('id="generate_btn"');
    await app.close();
  });
});
