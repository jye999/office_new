// WayfairController (routes/web.php:465 Route::resource, 466-469 Route::any;
// group middleware role:admin,user,remote). Ported faithfully — Debugbar calls
// dropped. The old controller only defines index() and store(); the other six
// resource actions 500 (missing method). /Wayfair.registerOrder and
// /Wayfair.packingSlip call the Wayfair API (token + register/packing-slip) and
// are verified by code review only (no external calls in tests).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, nowDb } from '../../db.js';
import { readExcel } from '../../excel.js';
import { input } from '../../http.js';
import { any, resource } from '../../router.js';
import { date, render, sendServer500 } from '../../view.js';
import { Wayfair } from '../../lib/wayfair.js';

const ROLES = ['admin', 'user', 'remote'];
type Row = Record<string, unknown>;

// PHP str_getcsv($line) defaults (delimiter ',', enclosure '"', escape '\\'),
// one line at a time. Trailing empty fields are dropped (PHP behaviour).
// shortcut: file() keeps a trailing newline per line and str_getcsv strips it;
// we strip a trailing \r?\n before parsing. Rare enclosure edge cases are not
// exercised by the app's Wayfair CSVs.
function strGetCsv(line: string): string[] {
  const s = line.replace(/\r?\n$/, '');
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\') cur += s[++i] ?? '';
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// file() without flags: split on \r\n | \n | \r, no trailing empty line.
function fileLines(buf: Buffer): string[] {
  const lines = buf.toString('utf8').split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Product::with('locations','images')->where('sku','=',$sku)->first(): no
// $hidden/$casts, $appends = ['type','sku_num']; hasMany, no ORDER BY.
// Returns null when no product matches (Eloquent ->first()).
async function productBySku(sku: unknown, withImages: boolean): Promise<Row | null> {
  // SAFETY: selectAll() yields one object per row with every column (Eloquent
  // serialises all columns); the Record cast is exact.
  const row = (await db
    .selectFrom('os_products')
    .selectAll()
    .where('sku', '=', String(sku ?? ''))
    .limit(1)
    .executeTakeFirst()) as unknown as Row | undefined;
  if (!row) return null;
  const id = row['id'] as number;
  const chars = [...String(row['sku'] ?? '')];
  // SAFETY: full os_product_locations rows -> Record (see above).
  const locations = (await db
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', '=', id)
    .execute()) as unknown as Row[];
  let images: Row[] = [];
  if (withImages) {
    // os_product_images.product_id is a VARCHAR column (string compare, as PHP).
    // SAFETY: full os_product_images rows -> Record (see above).
    images = (await db
      .selectFrom('os_product_images')
      .selectAll()
      .where('product_id', '=', String(id))
      .execute()) as unknown as Row[];
  }
  return {
    ...row,
    type: chars[0] ?? '',
    sku_num: chars.slice(1).join(''),
    locations,
    images,
  };
}

// Multipart file part 'report': drain the stream while iterating req.parts()
// (busboy pauses otherwise). Returns the buffer, or null when no file was sent.
async function reportFile(req: FastifyRequest): Promise<Buffer | null> {
  if (!req.isMultipart()) return null;
  for await (const part of req.parts()) {
    const p = part as { fieldname: string; filename?: string; file?: unknown; toBuffer: () => Promise<Buffer> };
    if (p.file && p.fieldname === 'report') return await p.toBuffer();
  }
  return null;
}

// getTokenFromDB(): a WayfairToken setting refreshed within the last 10h is
// reused; otherwise fetch a fresh token (external) and upsert the setting.
export async function getTokenFromDB(): Promise<Wayfair> {
  const tenHours = date('Y-m-d H:i:s', new Date(Date.now() - 10 * 3600 * 1000).getTime());
  // SAFETY: Kysely types the datetime column as Date; the 'YYYY-MM-DD HH:mm:ss' string compares correctly.
  const tenHoursDate = tenHours as unknown as Date;
  const s = await db
    .selectFrom('os_settings')
    .select(['name', 'value'])
    .where('name', '=', 'WayfairToken')
    .where('updated_at', '>=', tenHoursDate)
    .executeTakeFirst();
  if (s == null) {
    const w = new Wayfair();
    const token = await w.fetchToken();
    const existing = await db
      .selectFrom('os_settings')
      .select('id')
      .where('name', '=', 'WayfairToken')
      .executeTakeFirst();
    // SAFETY: Kysely types timestamp columns as Date; mysql2 sends the string through unchanged.
    const ts = nowDb() as unknown as Date;
    if (existing) {
      await db
        .updateTable('os_settings')
        .set({ value: token, updated_at: ts })
        .where('id', '=', existing.id)
        .execute();
    } else {
      await db
        .insertInto('os_settings')
        .values({ name: 'WayfairToken', value: token, created_at: ts, updated_at: ts })
        .execute();
    }
    return new Wayfair(token);
  }
  return new Wayfair(s.value);
}

// store() CSV parse (WayfairController.php:114-246) -> $regdatesList.
async function parseStoreCsv(buf: Buffer): Promise<Row[]> {
  const csvAsArray = fileLines(buf).map(strGetCsv);
  let first = true;
  let itemNumIdx = -1;
  let itemNnameIdx = -1;
  let qtyIdx = -1;
  let regIdx = -1;
  let poIdx = -1;
  let shipnameIdx = -1;
  const regdates: Record<string, Row> = {};
  for (const line of csvAsArray) {
    if (first) {
      first = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === 'Item Number') itemNumIdx = i;
        if (line[i] === 'Item Name') itemNnameIdx = i;
        if (line[i] === 'Quantity') qtyIdx = i;
        if (line[i] === 'Registered Timestamp') regIdx = i;
        if (line[i] === 'PO Number') poIdx = i;
        if (line[i] === 'Ship To Name') shipnameIdx = i;
      }
      continue;
    }
    const itemNum = line[itemNumIdx];
    if (line[regIdx] == null || line[regIdx] === '') continue;
    const po = line[poIdx];
    const sku = String(itemNum ?? '').replaceAll('"', '').replaceAll('=', '');
    const regdate = String(line[regIdx]).slice(0, 10);
    const reg = (regdates[regdate] ??= {});
    if (reg['reg'] == null) reg['reg'] = regdate;
    const skuMap: Record<string, Row> = (reg['sku'] as Record<string, Row> | undefined) ?? (reg['sku'] = {});
    if (skuMap[sku] != null) {
      // PHP: qty = qty + line[qty] — first value is a string, addition yields a number.
      skuMap[sku]['qty'] = Number(skuMap[sku]['qty']) + Number(line[qtyIdx]);
    } else {
      // Product looked up at first sight (with locations + images), like the PHP.
      skuMap[sku] = { sku, name: line[itemNnameIdx], qty: line[qtyIdx], product: await productBySku(sku, true), reg: regdate };
    }
    const poMap: Record<string, Row[]> = (reg['po'] as Record<string, Row[]> | undefined) ?? (reg['po'] = {});
    poMap[po] = poMap[po] ?? [];
    poMap[po].push({ po, regtime: line[regIdx], shipname: line[shipnameIdx], sku, name: line[itemNnameIdx], qty: line[qtyIdx] });
  }
  // ksort($regdates) by key; per reg: ksort($reg) (po, reg, sku), sku/po -> lists.
  const list: Row[] = [];
  for (const k of Object.keys(regdates).sort()) {
    const reg = regdates[k];
    const skuEntries = Object.values(reg['sku'] as Record<string, Row>);
    const poEntries = Object.values(reg['po'] as Record<string, Row[]>);
    list.push({ po: poEntries.flat(), reg: reg['reg'], sku: skuEntries });
  }
  return list;
}

export function registerWayfairRoutes(app: FastifyInstance): void {
  resource(app, '/Wayfair', {
    index: async (req, reply) => {
      await render(req, reply, 'wayfair/index', {});
    },
    store: async (req, reply) => {
      const file = await reportFile(req);
      const regdatesList = file ? await parseStoreCsv(file) : [];
      reply.send(regdatesList);
    },
    // create/show/edit/update/destroy do not exist on the old controller.
    create: sendServer500,
    show: sendServer500,
    edit: sendServer500,
    update: sendServer500,
    destroy: sendServer500,
  }, { roles: ROLES });

  // Route::any('/Wayfair.store') -> same store() action.
  any(app, {
    path: '/Wayfair.store',
    name: 'Wayfair.store',
    roles: ROLES,
    handler: async (req, reply) => {
      const file = await reportFile(req);
      const regdatesList = file ? await parseStoreCsv(file) : [];
      reply.send(regdatesList);
    },
  });

  // Route::any('/Wayfair.registerOrder'): external register (shipping label) +
  // GrantOrder/Tracking writes. Verified by code review only.
  any(app, {
    path: '/Wayfair.registerOrder',
    name: 'Wayfair.registerOrder',
    roles: ROLES,
    handler: async (req, reply) => {
      const poNumber = String(input(req, 'poNumber') ?? '');
      const wayfair = await getTokenFromDB();
      const response = await wayfair.RegisterOrder(poNumber);
      // PHP loose ==: a successful RegisterOrder returns the poNumber itself.
      if (String(response) === poNumber && poNumber !== '') {
        // SAFETY: Kysely types the datetime columns as Date; the string compares/stores correctly.
        const ts = nowDb() as unknown as Date;
        const gorder = await db
          .selectFrom('os_grant_order')
          .select('id')
          .where('orderId', '=', poNumber)
          .executeTakeFirst();
        if (gorder != null) {
          await db
            .updateTable('os_grant_order')
            .set({ status: 'Done', updated_at: ts })
            .where('id', '=', gorder.id)
            .execute();
        }
        await db
          .insertInto('os_trackings')
          .values({
            orderId: poNumber,
            store: 'WF',
            tracking: 'N/A',
            Url: `https://api.wayfair.com/v1/shipping_label/${poNumber}`,
            localUrl: `${poNumber}.pdf`,
            Amount: 0,
            created_at: ts,
            updated_at: ts,
          })
          .execute();
        return reply.code(200).type('text/html; charset=UTF-8').send(poNumber);
      }
      return reply.send(response);
    },
  });

  // Route::any('/Wayfair.packingSlip'): external packing-slip fetch, empty 200.
  any(app, {
    path: '/Wayfair.packingSlip',
    name: 'Wayfair.packingSlip',
    roles: ROLES,
    handler: async (req, reply) => {
      const poNumber = String(input(req, 'poNumber') ?? '');
      const wayfair = await getTokenFromDB();
      await wayfair.GetPackingSlip(poNumber);
      return reply.code(200).send('');
    },
  });

  // Route::any('/Wayfair.picklist'): Excel (heading mode) -> per-row product.
  any(app, {
    path: '/Wayfair.picklist',
    name: 'Wayfair.picklist',
    roles: ROLES,
    handler: async (req, reply) => {
      const pickList: Row[] = [];
      const file = await reportFile(req);
      if (file) {
        const data = await readExcel(file, {});
        for (const value of data as Row[]) {
          const product = await productBySku(value['item_number'], true);
          value['product'] = product;
          pickList.push(value);
        }
      }
      reply.send(pickList);
    },
  });
}
