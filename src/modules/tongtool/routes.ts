// TongtoolController (routes/web.php:471 Route::resource, 472 Route::any;
// group middleware role:admin,user,remote). Ported faithfully — Debugbar calls
// dropped. The old controller only defines index() and picklist(); the other six
// resource actions 500 (missing method).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../db.js';
import { readExcel } from '../../excel.js';
import { any, resource } from '../../router.js';
import { render, sendServer500 } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
type Row = Record<string, unknown>;

// Product::with('locations')->where('sku','=',$sku)->first(): no $hidden/$casts,
// $appends = ['type','sku_num']; hasMany, no ORDER BY; no images (only locations).
async function productBySku(sku: unknown): Promise<Row | null> {
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
  return {
    ...row,
    type: chars[0] ?? '',
    sku_num: chars.slice(1).join(''),
    locations,
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

// picklist() (TongtoolController.php:41-73): Excel noHeading rows, first row is a
// header and is skipped, d[1] is the sku. A PHP list with a string key encodes as
// a JSON object with numeric string keys, so each row becomes such an object.
async function buildPicklist(file: Buffer | null): Promise<Row[]> {
  const pickList: Row[] = [];
  if (file) {
    const data = (await readExcel(file, { noHeading: true })) as unknown[][];
    let isHeader = true;
    for (const d of data) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      const product = await productBySku(d[1]);
      const obj: Row = {};
      for (let i = 0; i < d.length; i++) obj[String(i)] = d[i];
      obj['product'] = product;
      pickList.push(obj);
    }
  }
  return pickList;
}

export function registerTongtoolRoutes(app: FastifyInstance): void {
  resource(app, '/Tongtool', {
    index: async (req, reply) => {
      await render(req, reply, 'tongtool/index', {});
    },
    // create/store/show/edit/update/destroy do not exist on the old controller.
    create: sendServer500,
    store: sendServer500,
    show: sendServer500,
    edit: sendServer500,
    update: sendServer500,
    destroy: sendServer500,
  }, { roles: ROLES });

  any(app, {
    path: '/Tongtool.picklist',
    name: 'Tongtool.picklist',
    roles: ROLES,
    handler: async (req, reply) => {
      reply.send(await buildPicklist(await reportFile(req)));
    },
  });
}
