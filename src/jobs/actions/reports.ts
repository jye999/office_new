// J6: Runner.php sync actions scheduled in Kernel.php: windy, mermaid, stats, email-sales-report and
// email-sales-tax-report. The unscheduled, un-routed ones (track-shipment-status, scanform, create-thumbnail,
// refresh-all-images, recal-inv, get-keywords, test) stay unregistered like Runner's silent unknown-action no-op.
// Every DB write and mail is skipped under DRY_RUN=1 at the action level.

import { db, sql } from '../../db.js';
import { sendMail } from '../../mail.js';
import { date, e, strtotime } from '../../view.js';

const dryRun = () => process.env.DRY_RUN === '1';
const quietDryRun = (action: string, what: string) => {
  console.info(`[DRY_RUN] sync ${action}: ${what} skipped`);
  return 0;
};

// Laravel runs every DB::statement on one connection; the windy/mermaid `@running_balance` session variable needs that too.
async function runStatements(statements: string[]): Promise<void> {
  await db.connection().execute(async (conn) => {
    for (const statement of statements) await sql.raw(statement).execute(conn);
  });
}

// windy and mermaid are the same nine statements for different hwc company ids / os_grant_order stores.
export const hwcShipStatements = (companyId: number, store: string): string[] => [
  `
                INSERT INTO hwc.account_balance 
                (company_id, created_by, updated_by, fee_type, amount, note, created_at, updated_at, running_balance)
                SELECT 
                    ${companyId}, -- company_id
                    1, -- created_by
                    1, -- updated_by
                    'POSTAGE', -- fee_type
                    ROUND(IFNULL(ot.DiscountedRate, ot.Amount * 1.1), 2) * -1 AS amount,
                    CONCAT('Order ID: ', ogo.orderId) AS note,
                    ot.created_at,
                    ot.updated_at,
                    99999.99 AS running_balance
                FROM os_grant_order ogo
                INNER JOIN os_trackings ot ON ogo.orderId = ot.orderId
                INNER JOIN hwc.orders o ON ogo.orderId = o.po
                WHERE ogo.store = ${store}
                    AND ogo.status = 'submit'
                    AND o.status NOT IN ('Ship', 'Duplicate')
                    and IFNULL(ot.DiscountedRate, ot.Amount) is not null
                ORDER BY ot.created_at;
            `,
  `
                SET @running_balance = (
                    SELECT COALESCE(running_balance, 0) 
                    FROM hwc.account_balance 
                    WHERE company_id = ${companyId} 
                    and running_balance != 99999.99
                    ORDER BY id DESC 
                    LIMIT 1
                );
            `,
  `
                UPDATE hwc.account_balance
                SET running_balance = (@running_balance := @running_balance + amount)
                where running_balance=99999.99
                ORDER BY id;
            `,
  `insert into  hwc.trackings
            (order_id,carrier,service_type,tracking_number,url,price,shipdate,status,created_at,updated_at)
            select o.Id,
            case when tracking like '1Z%' then 'UPS'
                when length(tracking)=12 then 'FedEx'
                else 'USPS' end,
                'Standard',
                ot.tracking,
                '',
                round(ifnull(ot.DiscountedRate,ot.Amount * 1.1),2) as price,
                ot.created_at,
                'print',
                ot.created_at,
                ot.updated_at
            from os_grant_order ogo
            inner join os_trackings ot
            on ogo.orderId= ot.orderId
            inner join hwc.orders o
            on ogo.orderId = o.po
            where ogo.store=${store}
            and ogo.status='submit'
            and o.status not in ('Ship','Duplicate')
            ;`,
  `update hwc.orders o
            inner join os_grant_order ogo
            on ogo.orderId = o.po
            inner join os_trackings ot
            on ogo.orderId= ot.orderId
            set o.status='Ship'
            where ogo.store=${store}
            and ogo.status='submit'
            ;`,
  `update os_grant_order ogo
            inner join hwc.orders o
            on ogo.orderId = o.po
            inner join os_trackings ot
            on ogo.orderId= ot.orderId
            set ogo.status='Done'
            where ogo.store=${store}
            and ogo.status='submit';`,
  `
            update hwc.product_locations pl
                inner join (
                    select
                        product_id,
                        location_id,
                        sum(qty) as qty
                    from
                        (
                            select distinct
                                p.id as product_id,
                                (
                                    select
                                        id
                                    from
                                        hwc.product_locations
                                    where
                                        product_id = p.id
                                    order by
                                        check_in_date asc,
                                        qty desc
                                    limit
                                        1
                                ) as location_id,
                                oi.qty
                            from
                                hwc.trackings t
                                inner join hwc.orders o on t.order_id = o.id
                                inner join hwc.order_items oi on o.id = oi.order_id
                                inner join hwc.products p on oi.sku = p.sku
                                or oi.sku = p.fnsku
                                inner join hwc.product_locations pl on p.id = pl.product_id
                            where
                                pl.id is not null
                                and (
                                    oi.shipped_qty is null
                                    or oi.shipped_qty = 0
                                )
                                and o.status = 'Ship'
                        ) t
                    group by
                        product_id,
                        location_id
                ) l on pl.product_id = l.product_id
                and pl.id = l.location_id
                set
                    pl.qty = pl.qty - l.qty
            ;`,
  `
            insert into hwc.product_movement_history (created_at, updated_at, action,created_by,company_id,product_id,location,qty,reference,checkin_date,running_total)
            select distinct t.shipdate , t.shipdate ,'SHIP',1,o.company_id,
            p.id as product_id,
            (select location from hwc.product_locations where product_id = p.id order by qty desc limit 1) as location,
            oi.qty * -1 ,t.tracking_number as reference, t.shipdate  as checkin_date,1
            from hwc.trackings t
            inner join hwc.orders o
            on t.order_id = o.id
            inner join hwc.order_items oi
            on o.id = oi.order_id
            inner join hwc.products p
            on oi.sku = p.sku or oi.sku = p.fnsku
            inner join hwc.product_locations pl
            on p.id = pl.product_id
            where pl.id is not null
            and (oi.shipped_qty is null or oi.shipped_qty=0)
            and o.status='Ship'
            ;`,
  `update hwc.trackings t
            inner join hwc.orders o
            on t.order_id = o.id
            inner join hwc.order_items oi
            on o.id = oi.order_id
            set oi.shipped_qty=oi.qty
            where  o.status='Ship'
            and (oi.shipped_qty is null or oi.shipped_qty=0);`
];

export const statsStatements: string[] = [
  `delete from os_SalesSummary where  \`Date\`>=DATE_SUB(cast(now() as date), INTERVAL 1 DAY);`,
  `INSERT INTO \`office\`.\`os_SalesSummary\`
            (
            \`Date\`,
            \`Channel\`,
            \`Fulfillment\`,
            \`Order\`,
            \`QTY\`,
            \`Price\`,
            \`Tax\`,
            \`Shipping\`) 
                SELECT
            cast(purchaseDate as date),
                 ogo.store                 AS channel,
                        'Merchant'            AS fulfillment,
                        count(DISTINCT ogo.orderId) orderNumber,
                        0 as qty,
                        round(sum(ifNull(ogo.total, 0)),2) price,
                        round(sum(ifNull(ogo.tax, 0))  ,2)                   AS tax,
                        round(sum(ifNull(ogo.shippingCost, 0)),2)                     AS shipping
                   FROM os_grant_order ogo
                  WHERE    (ogo.store != 'A'
                        AND ogo.store != 'O'
                        AND ogo.store != 'W'
                        AND ogo.store != 'WF')
                        and purchaseDate >=DATE_SUB(cast(now() as date), INTERVAL 1 DAY)
                GROUP BY cast(purchaseDate as date),ogo.store 
            ;`,
  `
            INSERT INTO \`office\`.\`os_SalesSummary\`
            (
            \`Date\`,
            \`Channel\`,
            \`Fulfillment\`,
            \`Order\`,
            \`QTY\`,
            \`Price\`,
            \`Tax\`,
            \`Shipping\`)
            SELECT 
            CAST(CONVERT_TZ(CAST(left(\`purchase-date\`,19) AS DATETIME),'GMT','America/Los_Angeles') as date),
                       \`sales-channel\`                  channel,
                        \`fulfillment-channel\`           fulfillment,
                        count(DISTINCT \`amazon-order-id\`) orderNumber,
                        sum(ifNull(quantity, 0))        qty,
                        ROUND(CASE
                           WHEN \`sales-channel\` = 'Amazon.ca'
                           THEN
                              sum(ifNull(\`item-price\`, 0)) * 0.8
                           WHEN \`sales-channel\` = 'Amazon.com.mx'
                           THEN
                              sum(ifNull(\`item-price\`, 0)) * 0.054
                           ELSE
                              sum(ifNull(\`item-price\`, 0))
                        END,2)
                           price,
                        ROUND(CASE
                           WHEN \`sales-channel\` = 'Amazon.ca'
                           THEN
                              sum(ifNull(\`item-tax\`, 0)) * 0.8
                           WHEN \`sales-channel\` = 'Amazon.com.mx'
                           THEN
                              sum(ifNull(\`item-tax\`, 0)) * 0.054
                           ELSE
                              sum(ifNull(\`item-tax\`, 0))
                        END,2)
                           tax,
                        ROUND(CASE
                           WHEN \`sales-channel\` = 'Amazon.ca'
                           THEN
                              sum(ifNull(\`shipping-price\`, 0)) * 0.8
                           WHEN \`sales-channel\` = 'Amazon.com.mx'
                           THEN
                              sum(ifNull(\`shipping-price\`, 0)) * 0.054
                           ELSE
                              sum(ifNull(\`shipping-price\`, 0))
                        END,2)
                           shipping
                   FROM os_AMZ_ORDERS
                   WHERE \`order-status\` != 'Cancelled'
                        AND \`sales-channel\` != 'Non-Amazon'
                        and CAST(CONVERT_TZ(CAST(left(\`purchase-date\`,19) AS DATETIME),'GMT','America/Los_Angeles') as date)>=DATE_SUB(cast(now() as date), INTERVAL 1 DAY)
                  GROUP BY CAST(CONVERT_TZ(CAST(left(\`purchase-date\`,19) AS DATETIME),'GMT','America/Los_Angeles') as date),
                  \`sales-channel\`, 
                  \`fulfillment-channel\` ;`,
  `
            INSERT INTO \`office\`.\`os_SalesSummary\`
(
\`Date\`,
\`Channel\`,
\`Fulfillment\`,
\`Order\`,
\`QTY\`,
\`Price\`,
\`Tax\`,
\`Shipping\`)
	  SELECT 
	  CAST(created_at AS DATETIME),
	  store                 AS channel,
            'Merchant'            AS fulfillment,
            count(DISTINCT orderId) orderNumber,
            sum(ifNull(qty, 0))   qty,
            round(sum(ifNull(price, 0)),2) price,
            0                     AS tax,
            0                     AS shipping
       FROM os_grant_orderdetail
      WHERE     store = 'W'
            and CAST(created_at AS DATETIME)>=DATE_SUB(cast(now() as date), INTERVAL 1 DAY)
   GROUP BY CAST(created_at AS DATETIME),store;`,
  `
   INSERT INTO \`office\`.\`os_SalesSummary\`
(
\`Date\`,
\`Channel\`,
\`Fulfillment\`,
\`Order\`,
\`QTY\`,
\`Price\`,
\`Tax\`,
\`Shipping\`)
SELECT 
	  CAST(CONVERT_TZ(CAST(\`created_at\` AS DATETIME),'GMT','America/New_York') as Date),
           'Faire'  as                channel,
           'Faire'           fulfillment,
            count(DISTINCT \`order_id\`) orderNumber,
            1 as        qty,
            sum(payout_total) as                price,
            0 as                tax,
            0 as  shipping
       FROM os_faire_orders  
      WHERE
      order_status!='CANCELED' and
             CONVERT_TZ(CAST(\`created_at\` AS DATETIME),'GMT','America/New_York')>=DATE_SUB(cast(now() as date), INTERVAL 1 DAY)
   GROUP BY CAST(CONVERT_TZ(CAST(\`created_at\` AS DATETIME),'GMT','America/New_York') as Date)`,
  `
   update os_SalesSummary as  os    inner join (
  SELECT
cast(purchaseDate as date) as pDate,
   ogo.store                 AS c,
   sum(ifNull(ogod.qty, 0)) as qty
     FROM os_grant_order ogo
     inner join os_grant_orderdetail ogod on ogo.orderId = ogod.orderId and ogo.store = ogod.store
    WHERE    (ogo.store != 'A'
          AND ogo.store != 'O'
          AND ogo.store != 'W'
          AND ogo.store != 'WF')
          and CAST(purchaseDate AS DATETIME)>=DATE_SUB(cast(now() as date), INTERVAL 1 DAY)
  GROUP BY cast(purchaseDate as date),ogo.store 
  ) a
  on os.\`Date\`=a.pDate and os.Channel=a.c
  set os.qty = a.qty;`
];

// SalesTaxNotification: previous calendar month in the app timezone (`first/last day of last month`).
function lastMonthRange(): { start: string; end: string } {
  const year = Number(date('Y'));
  const month = Number(date('n'));
  const first = new Date(Date.UTC(year, month - 2, 1));
  const last = new Date(Date.UTC(year, month - 1, 0));
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  return { start: ymd(first), end: ymd(last) };
}

// emails/salestax.blade.php
function salesTaxHtml(sales: Record<string, unknown>[], start: string, end: string): string {
  const cell = (v: unknown) => `            <td style="border: 1px solid black;">${e(v)}</td>\n`;
  const rows = sales.map((s) => `        <tr>\n${cell(s.county)}${cell(s.total)}${cell(s.tax)}        </tr>\n`).join('');
  const body =
    sales.length < 1
      ? '<div>There is no sales in Georgia in shopify store during this period.</div>\n'
      : `<table id="salesTable" class="table table-bordered table-condensed" style="border: 1px solid black;" >\n    <thead>\n        <tr>\n            <td style="border: 1px solid black;">County</td>\n            <td style="border: 1px solid black;">Total</td>\n            <td style="border: 1px solid black;">Tax</td>\n        </tr>\n    </thead>\n    <tbody>\n${rows}    </tbody>\n</table>\n`;
  return `<!DOCTYPE html>\n<html>\n<body>\n<style>\ntable {\n    font-size:14pt;\n}\n</style>\n<strong >Georgia sales report Shopify only</strong>\n<div>\nFrom ${e(start)} To ${e(end)}\n</div>\n${body}</body>\n</html>`;
}

export async function emailSalesTaxReport(): Promise<void> {
  const { start, end } = lastMonthRange();
  const { rows } = await sql`call SalesTaxReport(${start},${end})`.execute(db);
  // mysql2 returns [procedure result set, trailing OK packet] for CALL; PHP's PDO only sees the result set.
  const sales = (Array.isArray(rows[0]) ? rows[0] : []) as Record<string, unknown>[];
  await sendMail({
    from: 'johnny@angelisabella.com',
    to: 'johnny@angelisabella.com',
    subject: 'Angel Isabella Georgia Shopify sales ' + date('Y-m', strtotime(`${start} 00:00:00`)),
    html: salesTaxHtml(sales, start, end),
  });
}

const SALES_CHANNELS: Record<string, string> = { E: 'Ebay', R: '6 - R Store', S: 'Shopify', T: 'Etsy', T2: 'Etsy2', T3: 'Etsy3 - Rental', H: 'Houzz', W: 'Walmart' };

// Same table as views/report/sales.njk (Total = price + tax + shipping), with a totals row.
export function salesReportHtml(sales: Record<string, unknown>[], day: string): string {
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cell = (v: unknown, right = false) => `<td style="border: 1px solid black; padding: 2px 8px;${right ? ' text-align: right;' : ''}">${e(v)}</td>`;
  let orders = 0;
  let qty = 0;
  let total = 0;
  const rows = sales
    .map((s) => {
      const rowTotal = num(s.price) + num(s.tax) + num(s.shipping);
      orders += num(s.orderNumber);
      qty += num(s.qty);
      total += rowTotal;
      const channel = SALES_CHANNELS[String(s.channel)] ?? s.channel;
      return `<tr>${cell(channel)}${cell(s.fulfillment)}${cell(s.orderNumber, true)}${cell(s.qty, true)}${cell(money(rowTotal), true)}</tr>`;
    })
    .join('\n');
  const head = ['Channel', 'Fulfillment', 'Orders', 'Qty', 'Total'].map((h) => `<td style="border: 1px solid black; padding: 2px 8px;"><strong>${h}</strong></td>`).join('');
  const foot = `<tr><td colspan="2" style="border: 1px solid black; padding: 2px 8px;"><strong>Total</strong></td>${[String(orders), String(qty), money(total)].map((v) => `<td style="border: 1px solid black; padding: 2px 8px; text-align: right;"><strong>${v}</strong></td>`).join('')}</tr>`;
  const body =
    sales.length < 1
      ? '<div>There were no sales on this day.</div>'
      : `<table style="border: 1px solid black; border-collapse: collapse; font-size: 14pt;">\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n<tfoot>${foot}</tfoot>\n</table>`;
  return `<!DOCTYPE html>\n<html>\n<body>\n<strong>Sales report for ${e(day)}</strong>\n<div style="color: red; font-size: 10pt;">Amazon.ca $ is in CAD, not USD</div>\n${body}\n</body>\n</html>`;
}

// Runs at 03:15 app time: report the whole previous calendar day (00:00:00-23:59:59).
export async function emailSalesReport(): Promise<void> {
  const yesterday = date('Y-m-d', strtotime('yesterday'));
  const { rows } = await sql`call SalesReport(${yesterday + ' 00:00:00'},${yesterday + ' 23:59:59'})`.execute(db);
  // mysql2 returns [procedure result set, trailing OK packet] for CALL.
  const sales = (Array.isArray(rows[0]) ? rows[0] : []) as Record<string, unknown>[];
  await sendMail({
    from: 'johnny@angelisabella.com',
    to: ['johnny@angelisabella.com', 'angela@angelisabella.com'],
    subject: `Angel Isabella sales ${yesterday}`,
    html: salesReportHtml(sales, yesterday),
  });
}

export const reportActions: Record<string, (arg1?: string) => Promise<number>> = {
  windy: async () => {
    if (dryRun()) return quietDryRun('windy', 'hwc ship sync DB writes');
    await runStatements(hwcShipStatements(2, "'WINDY'"));
    return 0;
  },
  mermaid: async () => {
    if (dryRun()) return quietDryRun('mermaid', 'hwc ship sync DB writes');
    await runStatements(hwcShipStatements(8, "'mermaid'"));
    return 0;
  },
  stats: async () => {
    if (dryRun()) return quietDryRun('stats', 'os_SalesSummary DB writes');
    await runStatements(statsStatements);
    return 0;
  },
  'email-sales-report': async () => {
    if (dryRun()) return quietDryRun('email-sales-report', 'report query and mail');
    await emailSalesReport();
    return 0;
  },
  'email-sales-tax-report': async () => {
    if (dryRun()) return quietDryRun('email-sales-tax-report', 'report query and mail');
    await emailSalesTaxReport();
    return 0;
  },
};
