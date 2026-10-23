// T24 — PDA API (routes/api.php:67-78, prefix `pda`, middleware pda.auth).
// Port of app/Http/Controllers/PdaController.php. JSON-only; the old app's
// error bodies ({message}, 401/404/409/422) are reproduced verbatim.
//
// Note: POST /api/pda/api-key (routes/api.php:26, auth:api) is owned by T02 in
// src/modules/api/routes.ts and is NOT registered here.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, nowDb, sql } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { strtotime } from '../../view.js';
import { ensureDefaultStillStocked, mergeDuplicateLocations } from '../../lib/warehouseLocation.js';

// SAFETY: Kysely types datetime/timestamp columns as Date, but the pool runs
// with mysql2 dateStrings (T00) so runtime values are 'YYYY-MM-DD HH:mm:ss'
// strings — same shape PHP PDO gave Laravel.
const dcol = (v: string) => v as unknown as Date;

// ---------------------------------------------------------------- input helpers

// Laravel `$request->query('x', $request->input('x'))`: the query value wins,
// and even an empty-string query value blocks the body fallback (the default
// is only used when the key is absent/null).
function queryFirst(req: FastifyRequest, key: string): unknown | null {
  const query = (req.query ?? {}) as Record<string, unknown>;
  return key in query && query[key] !== null ? query[key] : input(req, key);
}

// Laravel `$request->has('x')`: present in body/query and not null.
function hasInput(req: FastifyRequest, key: string): boolean {
  return input(req, key) !== null;
}

// PHP (int) cast: leading numeric prefix, whitespace skipped, else 0.
function phpInt(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  if (v === null || v === undefined) return 0;
  const m = /^[+-]?(\d+)/.exec(String(v).trimStart());
  return m ? parseInt(m[1], 10) : 0;
}

// PHP is_numeric (for the page/pageSize guards).
function isNumeric(v: unknown): boolean {
  return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));
}

// Laravel's `date` validation rule ≈ strtotime() !== false.
function isValidDate(v: unknown): boolean {
  const s = String(v).trim();
  if (s === '') return false;
  return strtotime(s) !== 0 || !Number.isNaN(Date.parse(s));
}

function validationError(reply: FastifyReply, errors: Record<string, string>): FastifyReply {
  const message = Object.values(errors)[0] ?? '';
  return reply.code(422).send({ message, errors: Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, [v]])) });
}

// ---------------------------------------------------------------- serialization

// Product $appends = [type, sku_num]: mb_substr(sku, 0, 1) / mb_substr(sku, 1)
// (sku is an ASCII product code; null -> ''). Appends come after all columns.
function serializeProduct(row: Record<string, unknown>): Record<string, unknown> {
  const sku = typeof row.sku === 'string' ? row.sku : '';
  return { ...row, type: sku.charAt(0), sku_num: sku.slice(1) };
}

// PdaReceivingLine $dates: DATE columns serialize as 'YYYY-MM-DD 00:00:00'
// (verified against the live old app); a 19-char value passes through.
function serializeReceivingLine(row: Record<string, unknown>): Record<string, unknown> {
  const pad = (v: unknown) => (typeof v === 'string' && v.length === 10 ? `${v} 00:00:00` : v ?? null);
  return { ...row, received_date: pad(row.received_date), put_away_date: pad(row.put_away_date) };
}

// formatReceivingDateField(): null/'' -> null, else substr(string, 0, 10).
function fmtDate(v: unknown): string | null {
  return v === null || v === '' ? null : String(v).slice(0, 10);
}

async function findLocationRow(productId: number, locNorm: string) {
  return db
    .selectFrom('os_product_locations')
    .selectAll()
    .where('product_id', '=', productId)
    .where(sql`UPPER(TRIM(os_product_locations.location))`, '=', locNorm)
    .executeTakeFirst();
}

async function findProductBySku(sku: string) {
  return db.selectFrom('os_products').selectAll().where('sku', '=', sku).executeTakeFirst();
}

// logTransaction(): PdaInventoryTransaction::create (user from the api key).
async function logTransaction(req: FastifyRequest, data: Record<string, unknown>): Promise<void> {
  const user = (req as { pdaUser?: { id: number } }).pdaUser;
  const now = nowDb();
  await db
    .insertInto('os_pda_inventory_transactions')
    .values({
      user_id: user ? user.id : null,
      created_at: dcol(now),
      updated_at: dcol(now),
      ...data,
    } as never) // SAFETY: data is the fixed PdaInventoryTransaction fillable column set
    .execute();
}

// paginateTransactions()/paginateReceiving(): same page/pageSize logic.
function pdaPagination(req: FastifyRequest): { page: number; pageSize: number } {
  let page = 1;
  const p = input(req, 'page');
  if (p !== null && isNumeric(p)) page = Math.max(1, phpInt(p));
  let pageSize = 50;
  const ps = input(req, 'pageSize');
  if (ps !== null && isNumeric(ps)) pageSize = Math.min(200, Math.max(1, phpInt(ps)));
  return { page, pageSize };
}

const PDA_STATUSES = ['received', 'putaway', 'void'];

// ---------------------------------------------------------------- routes

export function registerPdaRoutes(app: import('fastify').FastifyInstance): void {
  // GET /api/pda/location — locationInquiry
  route(app, {
    verb: 'get',
    path: '/api/pda/location',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const location = queryFirst(req, 'location');
      if (location === null || String(location).trim() === '') {
        return validationError422(reply, 'location is required');
      }
      const locNorm = String(location).trim().toUpperCase();
      const rows = await db
        .selectFrom('os_product_locations')
        .selectAll()
        .where(sql`UPPER(TRIM(os_product_locations.location))`, '=', locNorm)
        .orderBy('id')
        .execute();
      const products = await db
        .selectFrom('os_products')
        .selectAll()
        .where('id', 'in', rows.map((r) => r.product_id as number))
        .execute();
      const byId = new Map(products.map((p) => [p.id, p] as const));
      // PHP with('product'): hasOne relation key appended after the columns (null when the product row is gone).
      const out = rows.map((r) => {
        const p = byId.get(r.product_id as number);
        return { ...r, product: p ? serializeProduct(p as Record<string, unknown>) : null };
      });
      reply.send({ location: locNorm, rows: out });
    },
  });

  // GET /api/pda/sku — skuInquiry
  route(app, {
    verb: 'get',
    path: '/api/pda/sku',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const sku = queryFirst(req, 'sku');
      if (sku === null || String(sku).trim() === '') return validationError422(reply, 'sku is required');
      const product = await findProductBySku(String(sku).trim());
      if (!product) return reply.code(404).send({ message: 'product not found' });
      const locations = await db.selectFrom('os_product_locations').selectAll().where('product_id', '=', product.id).execute();
      const images = await db.selectFrom('os_product_images').selectAll().where('product_id', '=', String(product.id)).execute();
      reply.send({ ...serializeProduct(product), locations, images });
    },
  });

  // POST /api/pda/inventory/qty — updateQtyBySkuLocation
  route(app, {
    verb: 'post',
    path: '/api/pda/inventory/qty',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const sku = input(req, 'sku');
      const location = input(req, 'location');
      if (sku === null || String(sku).trim() === '') return validationError422(reply, 'sku is required');
      if (location === null || String(location).trim() === '') return validationError422(reply, 'location is required');
      if (!hasInput(req, 'qty')) return validationError422(reply, 'qty is required');
      const qty = phpInt(input(req, 'qty'));
      const locNorm = String(location).trim().toUpperCase();
      const product = await findProductBySku(String(sku).trim());
      if (!product) return reply.code(404).send({ message: 'sku not found' });

      await mergeDuplicateLocations(product.id);
      const row = await findLocationRow(product.id, locNorm);
      const before = row ? row.qty : null;
      const now = nowDb();
      let resultRow: Record<string, unknown>;
      if (row) {
        await db
          .updateTable('os_product_locations')
          .set({ qty, location: locNorm, countdate: dcol(now), updated_at: dcol(now) })
          .where('id', '=', row.id)
          .execute();
        resultRow = { ...row, qty, location: locNorm, countdate: now };
      } else {
        const insert = {
          product_id: product.id,
          location: locNorm,
          qty,
          countdate: dcol(now),
          created_at: dcol(now),
          updated_at: dcol(now),
          ...(hasInput(req, 'packing') ? { packing: input(req, 'packing') as number } : {}),
          ...(hasInput(req, 'carton') ? { carton: input(req, 'carton') as number } : {}),
        };
        const res = await db.insertInto('os_product_locations').values(insert as Record<string, unknown>).executeTakeFirst();
        const newId = Number(res.insertId);
        resultRow = { id: newId, ...insert, countdate: now, created_at: now, updated_at: now } as Record<string, unknown>;
      }

      if (qty <= 0) await ensureDefaultStillStocked(product.id);

      await logTransaction(req, {
        product_id: product.id,
        sku: product.sku,
        location: locNorm,
        qty_before: before,
        qty_after: qty,
        transaction_type: 'qty_update',
        meta: JSON.stringify({ source: 'pda' }),
      });
      reply.send(resultRow);
    },
  });

  // POST /api/pda/inventory/link — addSkuLocation
  route(app, {
    verb: 'post',
    path: '/api/pda/inventory/link',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const sku = input(req, 'sku');
      const location = input(req, 'location');
      if (sku === null || String(sku).trim() === '') return validationError422(reply, 'sku is required');
      if (location === null || String(location).trim() === '') return validationError422(reply, 'location is required');
      const locNorm = String(location).trim().toUpperCase();
      const qty = hasInput(req, 'qty') ? phpInt(input(req, 'qty')) : 0;
      const product = await findProductBySku(String(sku).trim());
      if (!product) return reply.code(404).send({ message: 'sku not found' });

      await mergeDuplicateLocations(product.id);
      const existing = await findLocationRow(product.id, locNorm);
      if (existing) {
        return reply.code(409).send({ message: 'sku-location already exists', row: existing });
      }

      const now = nowDb();
      const insert = {
        product_id: product.id,
        location: locNorm,
        qty,
        countdate: dcol(now),
        created_at: dcol(now),
        updated_at: dcol(now),
        ...(hasInput(req, 'packing') ? { packing: input(req, 'packing') as number } : {}),
        ...(hasInput(req, 'carton') ? { carton: input(req, 'carton') as number } : {}),
      };
      const res = await db.insertInto('os_product_locations').values(insert as Record<string, unknown>).executeTakeFirst();
      const row = { id: Number(res.insertId), ...insert, countdate: now, created_at: now, updated_at: now } as Record<string, unknown>;

      await logTransaction(req, {
        product_id: product.id,
        sku: product.sku,
        location: locNorm,
        qty_before: null,
        qty_after: qty,
        transaction_type: 'add_sku_location',
        meta: JSON.stringify({ source: 'pda' }),
      });
      reply.code(201).send(row);
    },
  });

  // DELETE /api/pda/inventory/link — removeSkuLocation
  route(app, {
    verb: 'delete',
    path: '/api/pda/inventory/link',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const sku = input(req, 'sku');
      const location = input(req, 'location');
      if (sku === null || String(sku).trim() === '') return validationError422(reply, 'sku is required');
      if (location === null || String(location).trim() === '') return validationError422(reply, 'location is required');
      const locNorm = String(location).trim().toUpperCase();
      const product = await findProductBySku(String(sku).trim());
      if (!product) return reply.code(404).send({ message: 'sku not found' });

      await mergeDuplicateLocations(product.id);
      const row = await findLocationRow(product.id, locNorm);
      if (!row) return reply.code(404).send({ message: 'sku-location not found' });
      const before = row.qty === null ? 0 : row.qty;
      await db.deleteFrom('os_product_locations').where('id', '=', row.id).execute();
      await ensureDefaultStillStocked(product.id);

      await logTransaction(req, {
        product_id: product.id,
        sku: product.sku,
        location: locNorm,
        qty_before: before,
        qty_after: null,
        transaction_type: 'remove_sku_location',
        meta: JSON.stringify({ source: 'pda' }),
      });
      reply.send({ message: 'removed' });
    },
  });

  // GET /api/pda/transactions/sku — transactionsBySku
  route(app, {
    verb: 'get',
    path: '/api/pda/transactions/sku',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const sku = queryFirst(req, 'sku');
      if (sku === null || String(sku).trim() === '') return validationError422(reply, 'sku is required');
      const { page, pageSize } = pdaPagination(req);
      const skuTrim = String(sku).trim();
      const total = (
        await db.selectFrom('os_pda_inventory_transactions').selectAll().where(sql`os_pda_inventory_transactions.sku`, '=', skuTrim).execute()
      ).length;
      const items = await db
        .selectFrom('os_pda_inventory_transactions')
        .selectAll()
        .where(sql`os_pda_inventory_transactions.sku`, '=', skuTrim)
        .orderBy('id', 'desc')
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .execute();
      reply.send({ total, page, pageSize, transactions: items });
    },
  });

  // GET /api/pda/transactions/location — transactionsByLocation
  route(app, {
    verb: 'get',
    path: '/api/pda/transactions/location',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const location = queryFirst(req, 'location');
      if (location === null || String(location).trim() === '') return validationError422(reply, 'location is required');
      const locNorm = String(location).trim().toUpperCase();
      const { page, pageSize } = pdaPagination(req);
      const total = (
        await db.selectFrom('os_pda_inventory_transactions').selectAll().where(sql`UPPER(TRIM(os_pda_inventory_transactions.location))`, '=', locNorm).execute()
      ).length;
      const items = await db
        .selectFrom('os_pda_inventory_transactions')
        .selectAll()
        .where(sql`UPPER(TRIM(os_pda_inventory_transactions.location))`, '=', locNorm)
        .orderBy('id', 'desc')
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .execute();
      reply.send({ total, page, pageSize, transactions: items });
    },
  });

  // GET /api/pda/receiving — receivingIndex
  route(app, {
    verb: 'get',
    path: '/api/pda/receiving',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const status = queryFirst(req, 'status');
      let statusNorm: string | null = null;
      if (status !== null && String(status).trim() !== '') {
        statusNorm = String(status).trim().toLowerCase();
        if (!PDA_STATUSES.includes(statusNorm)) {
          return validationError422(reply, 'status must be one of: received, putaway, void');
        }
      }
      const { page, pageSize } = pdaPagination(req);
      // Kysely has no queryBuilder.clone() (immutable chaining).
      const base = statusNorm
        ? db.selectFrom('os_pda_receiving_lines').where('status', '=', statusNorm)
        : db.selectFrom('os_pda_receiving_lines');
      const total = (await base.selectAll().execute()).length;
      const items = await base.selectAll().orderBy('id', 'desc').offset((page - 1) * pageSize).limit(pageSize).execute();
      reply.send({ total, page, pageSize, lines: items.map(serializeReceivingLine) });
    },
  });

  // POST /api/pda/receiving — receivingStore
  route(app, {
    verb: 'post',
    path: '/api/pda/receiving',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      // Laravel rules: sku required|string|max:50; carton nullable|string|max:100;
      // per_carton/perCarton nullable|integer|min:0; qty required|integer|min:0;
      // received_date/receivedDate nullable|date; status nullable|in:...;
      // put_away_date/putAwayDate nullable|date. (nullable skips null only, not '')
      const errors: Record<string, string> = {};
      const v = (k: string) => input(req, k);
      const sku = v('sku');
      if (sku === null || (typeof sku === 'string' && sku.trim() === '')) errors.sku = 'The sku field is required.';
      else if (typeof sku !== 'string') errors.sku = 'The sku field must be a string.';
      else if (sku.length > 50) errors.sku = 'The sku field may not be greater than 50 characters.';
      const carton = v('carton');
      if (carton !== null) {
        if (typeof carton !== 'string') errors.carton = 'The carton field must be a string.';
        else if (carton.length > 100) errors.carton = 'The carton field may not be greater than 100 characters.';
      }
      for (const k of ['per_carton', 'perCarton']) {
        const val = v(k);
        if (val === null) continue;
        if (typeof val === 'number' ? !Number.isInteger(val) : (typeof val !== 'string' || !/^[+-]?\d+$/.test(val.trim()))) {
          errors[k] = `The ${k} field must be an integer.`;
        } else if (phpInt(val) < 0) errors[k] = `The ${k} field must be at least 0.`;
      }
      const qtyVal = v('qty');
      if (qtyVal === null || (typeof qtyVal === 'string' && qtyVal.trim() === '')) errors.qty = 'The qty field is required.';
      else if (typeof qtyVal === 'number' ? !Number.isInteger(qtyVal) : (typeof qtyVal !== 'string' || !/^[+-]?\d+$/.test(qtyVal.trim()))) {
        errors.qty = 'The qty field must be an integer.';
      } else if (phpInt(qtyVal) < 0) errors.qty = 'The qty field must be at least 0.';
      for (const k of ['received_date', 'receivedDate', 'put_away_date', 'putAwayDate']) {
        const val = v(k);
        if (val === null) continue;
        if (!isValidDate(val)) errors[k] = `The ${k} field must be a valid date.`;
      }
      const statusVal = v('status');
      if (statusVal !== null && !PDA_STATUSES.includes(String(statusVal))) {
        errors.status = 'The selected status is invalid.';
      }
      if (Object.keys(errors).length > 0) return validationError(reply, errors);

      let receivedDate = v('received_date') ?? v('receivedDate');
      if (receivedDate === null || receivedDate === '') receivedDate = nowDb().slice(0, 10);
      const status = v('status') ?? 'received';
      const putAwayDate = v('put_away_date') ?? v('putAwayDate');

      const lineSku = String(v('sku')).trim();
      const lineCarton = v('carton') !== null && String(v('carton')).trim() !== '' ? String(v('carton')).trim() : null;
      // PHP quirk: per_carton is only kept when BOTH per_carton and perCarton
      // are present and perCarton is a non-empty string (NOTES.md).
      const linePerCarton =
        v('per_carton') !== null && String(v('perCarton')).trim() !== '' ? String(v('per_carton')).trim() : null;
      const lineQty = phpInt(v('qty'));
      let putAway: string | null;
      if (putAwayDate !== null && putAwayDate !== '') putAway = String(putAwayDate);
      else if (status === 'putaway') putAway = nowDb().slice(0, 10);
      else putAway = null;

      const now = nowDb();
      const res = await db
        .insertInto('os_pda_receiving_lines')
        .values({
          sku: lineSku,
          carton: lineCarton,
          per_carton: linePerCarton as unknown as number, // SAFETY: per_carton is int; null passes through, '' failed the integer rule above
          qty: lineQty,
          status: String(status),
          received_date: dcol(receivedDate as string),
          put_away_date: (putAway ?? null) as unknown as Date | null,
          created_at: dcol(now),
          updated_at: dcol(now),
        })
        .executeTakeFirst();
      const line = {
        id: Number(res.insertId),
        sku: lineSku,
        carton: lineCarton,
        per_carton: linePerCarton,
        qty: lineQty,
        status: String(status),
        received_date: String(receivedDate),
        put_away_date: putAway,
        created_at: now,
        updated_at: now,
      } as Record<string, unknown>;

      const product = await findProductBySku(lineSku);
      await logTransaction(req, {
        product_id: product ? product.id : null,
        sku: lineSku,
        location: lineCarton,
        qty_before: null,
        qty_after: lineQty,
        transaction_type: 'receiving_create',
        meta: JSON.stringify({ source: 'pda', receiving_line_id: line.id, snapshot: receivingLineSnapshot(line) }),
      });
      reply.code(201).send(serializeReceivingLine(line));
    },
  });

  // PATCH /api/pda/receiving/{id} — receivingUpdate
  route(app, {
    verb: 'patch',
    path: '/api/pda/receiving/:id',
    middleware: ['pda.auth'],
    handler: async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const line = await db.selectFrom('os_pda_receiving_lines').selectAll().where('id', '=', id).executeTakeFirst();
      if (!line) return reply.code(404).send({ message: 'receiving line not found' });

      // sometimes|in:... / sometimes|integer|min:0 / sometimes|nullable|date
      const errors: Record<string, string> = {};
      const v = (k: string) => input(req, k);
      if (v('status') !== null && !PDA_STATUSES.includes(String(v('status')))) errors.status = 'The selected status is invalid.';
      const qtyVal = v('qty');
      if (qtyVal !== null) {
        if (typeof qtyVal === 'number' ? !Number.isInteger(qtyVal) : (typeof qtyVal !== 'string' || !/^[+-]?\d+$/.test(qtyVal.trim()))) {
          errors.qty = 'The qty field must be an integer.';
        } else if (phpInt(qtyVal) < 0) errors.qty = 'The qty field must be at least 0.';
      }
      for (const k of ['put_away_date', 'putAwayDate']) {
        const val = v(k);
        if (val === null) continue;
        if (!isValidDate(val)) errors[k] = `The ${k} field must be a valid date.`;
      }
      if (Object.keys(errors).length > 0) return validationError(reply, errors);

      const hasStatus = v('status') !== null;
      const hasQty = qtyVal !== null;
      const hasPutAway = v('put_away_date') !== null || v('putAwayDate') !== null;
      if (!hasStatus && !hasQty && !hasPutAway) {
        return validationError422(reply, 'provide status, qty, and/or put_away_date');
      }

      const beforeQty = line.qty === null ? 0 : line.qty;
      const beforeSnapshot = receivingLineSnapshot(line as unknown as Record<string, unknown>);

      const patch: Record<string, unknown> = {};
      if (hasStatus) patch.status = String(v('status'));
      if (hasQty) patch.qty = phpInt(qtyVal);
      if (hasPutAway) {
        const putAwayVal = v('put_away_date') !== null ? v('put_away_date') : v('putAwayDate');
        patch.put_away_date = putAwayVal === null || putAwayVal === '' ? null : String(putAwayVal);
      }
      if ((patch.status ?? line.status) === 'putaway' && !hasPutAway) {
        if (!line.put_away_date) patch.put_away_date = nowDb().slice(0, 10);
      }
      const updated = { ...line, ...patch } as Record<string, unknown>;
      await db
        .updateTable('os_pda_receiving_lines')
        .set({
          ...(patch as Record<string, unknown>),
          updated_at: dcol(nowDb())
        })
        .where('id', '=', id)
        .execute();

      const product = await findProductBySku(String(updated.sku));
      await logTransaction(req, {
        product_id: product ? product.id : null,
        sku: String(updated.sku),
        location: (updated.carton ?? null) as string | null,
        qty_before: beforeQty,
        qty_after: updated.qty === null ? 0 : (updated.qty as number),
        transaction_type: 'receiving_update',
        meta: JSON.stringify({
          source: 'pda',
          receiving_line_id: id,
          before: beforeSnapshot,
          after: receivingLineSnapshot(updated),
        }),
      });
      reply.send(serializeReceivingLine(updated));
    },
  });
}

function receivingLineSnapshot(line: Record<string, unknown>): Record<string, unknown> {
  return {
    receiving_line_id: line.id,
    sku: line.sku,
    carton: line.carton ?? null,
    per_carton: phpInt(line.per_carton),
    qty: phpInt(line.qty),
    status: line.status,
    received_date: fmtDate(line.received_date),
    put_away_date: fmtDate(line.put_away_date),
  };
}

function validationError422(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(422).send({ message });
}
