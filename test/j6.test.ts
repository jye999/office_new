// J6: windy, mermaid, stats, email-sales-report, email-sales-tax-report. No hwc/office row is written: the SQL
// statements are only validated with EXPLAIN (windy/mermaid UPDATE every matching real order), and mail stays in
// src/mail.ts's logged no-op mode (MAIL_ENABLED unset).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, sql } from '../src/db.js';
import { actions, runSyncAction } from '../src/jobs/actions.js';
import { emailSalesReport, emailSalesTaxReport, salesReportHtml, hwcShipStatements, statsStatements } from '../src/jobs/actions/reports.js';

describe('J6 report/sync actions', () => {
  beforeEach(() => {
    delete process.env.MAIL_ENABLED;
  });
  afterEach(() => {
    delete process.env.DRY_RUN;
    vi.restoreAllMocks();
  });

  it('registers only the five scheduled actions; the unscheduled Runner names stay no-ops', async () => {
    for (const name of ['windy', 'mermaid', 'stats', 'email-sales-report', 'email-sales-tax-report']) expect(actions.has(name)).toBe(true);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const name of ['track-shipment-status', 'scanform', 'create-thumbnail', 'refresh-all-images', 'recal-inv', 'get-keywords', 'test']) {
      expect(actions.has(name)).toBe(false);
      expect(await runSyncAction(name)).toBe(0);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('DRY_RUN=1 skips all five actions without touching the DB or mail', async () => {
    process.env.DRY_RUN = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const name of ['windy', 'mermaid', 'stats', 'email-sales-report', 'email-sales-tax-report']) expect(await runSyncAction(name)).toBe(0);
    expect(info.mock.calls.map((c) => c[0])).toEqual([
      '[DRY_RUN] sync windy: hwc ship sync DB writes skipped',
      '[DRY_RUN] sync mermaid: hwc ship sync DB writes skipped',
      '[DRY_RUN] sync stats: os_SalesSummary DB writes skipped',
      '[DRY_RUN] sync email-sales-report: report query and mail skipped',
      '[DRY_RUN] sync email-sales-tax-report: report query and mail skipped',
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it('windy and mermaid share nine statements that differ only by company id and store', () => {
    const windy = hwcShipStatements(2, "'WINDY'");
    const mermaid = hwcShipStatements(8, "'mermaid'");
    expect(windy).toHaveLength(9);
    expect(windy.filter((s) => s.includes("ogo.store = 'WINDY'") || s.includes("ogo.store='WINDY'"))).toHaveLength(4);
    expect(windy.filter((s) => /company_id = 2 /.test(s))).toHaveLength(1);
    expect(windy.join()).toContain('2, -- company_id');
    expect(mermaid.join()).not.toMatch(/WINDY|company_id = 2 /);
    expect(mermaid.join()).toContain("ogo.store='mermaid'");
    expect(mermaid.join()).toContain('8, -- company_id');
    expect(windy[1]).toContain('SET @running_balance');
  });

  it('stats and the windy/mermaid account_balance statements are valid against the live schema (EXPLAIN, nothing executed)', async () => {
    const dml = [...[hwcShipStatements(2, "'WINDY'"), hwcShipStatements(8, "'mermaid'")].flatMap((s) => [s[0], s[2]]), ...statsStatements];
    expect(dml).toHaveLength(2 * 2 + 6);
    for (const statement of dml) await sql.raw(`EXPLAIN ${statement}`).execute(db);
  });

  // The shared hwc schema has no `trackings`/`products` tables, so (like the old app) windy/mermaid fail at statement 4.
  it('the remaining windy statements fail on the missing hwc.trackings table as in the old app', async () => {
    await expect(sql.raw(`EXPLAIN ${hwcShipStatements(2, "'WINDY'")[3]}`).execute(db)).rejects.toThrow(/hwc\.trackings/);
  });

  it('email-sales-tax-report runs SalesTaxReport for last month and only logs the mail', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await emailSalesTaxReport();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /^\[mail disabled\] to=johnny@angelisabella\.com subject="Angel Isabella Georgia Shopify sales \d{4}-\d{2}"/,
    );
  });

  // The SalesReport procedure exists in production but not in every dev DB.
  it('email-sales-report mails yesterday\'s SalesReport to johnny and angela (logged only without MAIL_ENABLED)', async (ctx) => {
    const found = await sql<{ n: number }>`select count(*) as n from information_schema.routines where routine_schema = database() and routine_name = 'SalesReport'`.execute(db);
    if (Number(found.rows[0]?.n ?? 0) === 0) return ctx.skip();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await emailSalesReport();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /^\[mail disabled\] to=johnny@angelisabella\.com,angela@angelisabella\.com subject="Angel Isabella sales \d{4}-\d{2}-\d{2}"/,
    );
  });

  it('salesReportHtml totals price+tax+shipping per row and escapes values', () => {
    const html = salesReportHtml(
      [
        { channel: 'S', fulfillment: 'FBM', orderNumber: 2, qty: 5, price: '100.50', tax: '5.00', shipping: '10.00' },
        { channel: 'X<', fulfillment: null, orderNumber: 1, qty: 1, price: '1000.00', tax: null, shipping: null },
      ],
      '2026-10-26',
    );
    expect(html).toContain('Sales report for 2026-10-26');
    expect(html).toContain('Shopify');
    expect(html).toContain('115.50');
    expect(html).toContain('X&lt;');
    expect(html).toContain('1,115.50');
    expect(salesReportHtml([], '2026-10-26')).toContain('no sales');
  });

  it('DRY_RUN=1 skips all five actions without touching the DB or mail', async () => {
    process.env.DRY_RUN = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const name of ['windy', 'mermaid', 'stats', 'email-sales-report', 'email-sales-tax-report']) expect(await runSyncAction(name)).toBe(0);
    expect(info.mock.calls.map((c) => c[0])).toEqual([
      '[DRY_RUN] sync windy: hwc ship sync DB writes skipped',
      '[DRY_RUN] sync mermaid: hwc ship sync DB writes skipped',
      '[DRY_RUN] sync stats: os_SalesSummary DB writes skipped',
      '[DRY_RUN] sync email-sales-report: report query and mail skipped',
      '[DRY_RUN] sync email-sales-tax-report: report query and mail skipped',
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it('windy and mermaid share nine statements that differ only by company id and store', () => {
    const windy = hwcShipStatements(2, "'WINDY'");
    const mermaid = hwcShipStatements(8, "'mermaid'");
    expect(windy).toHaveLength(9);
    expect(windy.filter((s) => s.includes("ogo.store = 'WINDY'") || s.includes("ogo.store='WINDY'"))).toHaveLength(4);
    expect(windy.filter((s) => /company_id = 2 /.test(s))).toHaveLength(1);
    expect(windy.join()).toContain('2, -- company_id');
    expect(mermaid.join()).not.toMatch(/WINDY|company_id = 2 /);
    expect(mermaid.join()).toContain("ogo.store='mermaid'");
    expect(mermaid.join()).toContain('8, -- company_id');
    expect(windy[1]).toContain('SET @running_balance');
  });

  it('stats and the windy/mermaid account_balance statements are valid against the live schema (EXPLAIN, nothing executed)', async () => {
    const dml = [...[hwcShipStatements(2, "'WINDY'"), hwcShipStatements(8, "'mermaid'")].flatMap((s) => [s[0], s[2]]), ...statsStatements];
    expect(dml).toHaveLength(2 * 2 + 6);
    for (const statement of dml) await sql.raw(`EXPLAIN ${statement}`).execute(db);
  });

  // The shared hwc schema has no `trackings`/`products` tables, so (like the old app) windy/mermaid fail at statement 4.
  it('the remaining windy statements fail on the missing hwc.trackings table as in the old app', async () => {
    await expect(sql.raw(`EXPLAIN ${hwcShipStatements(2, "'WINDY'")[3]}`).execute(db)).rejects.toThrow(/hwc\.trackings/);
  });

  it('email-sales-tax-report runs SalesTaxReport for last month and only logs the mail', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await emailSalesTaxReport();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /^\[mail disabled\] to=johnny@angelisabella\.com subject="Angel Isabella Georgia Shopify sales \d{4}-\d{2}"/,
    );
  });

  it('email-sales-report fails on the missing SalesReport procedure like the old app and sends nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(emailSalesReport()).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});
