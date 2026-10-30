// Vendors: manage the vendor list (/api/vendors; the /Vendors page is the Vue SPA, see product routes) and assign one vendor to a product (SKU).
// os_vendors(name unique) / os_sku_vendors(sku unique -> one vendor per SKU, vendor_id FK ON DELETE RESTRICT).
// Not a port of the old app: new feature, session-auth like the other product APIs.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';

const ROLES = ['admin', 'user', 'remote'];

const clean = (v: unknown): string => String(v ?? '').trim();

// Vendors with how many SKUs use each one.
async function listVendors(): Promise<Array<{ id: number; name: string; notes: string | null; sku_count: number }>> {
  const { rows } = await sql<{ id: number; name: string; notes: string | null; sku_count: number }>`
    select v.id, v.name, v.notes, count(sv.id) as sku_count
    from os_vendors v left join os_sku_vendors sv on sv.vendor_id = v.id
    group by v.id, v.name, v.notes order by v.name`.execute(db);
  return rows.map((r) => ({ ...r, id: Number(r.id), sku_count: Number(r.sku_count) }));
}

async function nameTaken(name: string, exceptId = 0): Promise<boolean> {
  // Unique key uses a case/accent-insensitive collation, so compare the same way.
  const row = await db.selectFrom('os_vendors').select('id').where('name', '=', name).where('id', '!=', exceptId).executeTakeFirst();
  return row != null;
}

async function apiList(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await listVendors());
}

async function apiCreate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const name = clean(input(req, 'name'));
  const notes = clean(input(req, 'notes'));
  if (name === '') return reply.code(422).send({ success: false, message: 'Vendor name is required' });
  if (name.length > 100) return reply.code(422).send({ success: false, message: 'Vendor name is too long (max 100)' });
  if (await nameTaken(name)) return reply.code(409).send({ success: false, message: `Vendor "${name}" already exists` });
  const now = nowDb();
  const res = await db.insertInto('os_vendors').values({ name, notes: notes === '' ? null : notes, created_at: now, updated_at: now } as never).executeTakeFirst();
  reply.code(201).send({ success: true, id: Number(res.insertId), name, notes: notes === '' ? null : notes, sku_count: 0 });
}

async function apiUpdate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number((req.params as Record<string, string>)['id']);
  const existing = await db.selectFrom('os_vendors').select(['id', 'name', 'notes']).where('id', '=', id).executeTakeFirst();
  if (!existing) return reply.code(404).send({ success: false, message: 'vendor not found' });
  const rawName = input(req, 'name');
  const rawNotes = input(req, 'notes');
  const name = rawName === null || rawName === undefined ? existing.name : clean(rawName);
  const notes = rawNotes === null || rawNotes === undefined ? existing.notes : clean(rawNotes) === '' ? null : clean(rawNotes);
  if (name === '') return reply.code(422).send({ success: false, message: 'Vendor name is required' });
  if (name.length > 100) return reply.code(422).send({ success: false, message: 'Vendor name is too long (max 100)' });
  if (await nameTaken(name, id)) return reply.code(409).send({ success: false, message: `Vendor "${name}" already exists` });
  await db.updateTable('os_vendors').set({ name, notes, updated_at: nowDb() } as never).where('id', '=', id).execute();
  reply.send({ success: true, id, name, notes });
}

async function apiDelete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number((req.params as Record<string, string>)['id']);
  const existing = await db.selectFrom('os_vendors').select(['id', 'name']).where('id', '=', id).executeTakeFirst();
  if (!existing) return reply.code(404).send({ success: false, message: 'vendor not found' });
  const used = await db.selectFrom('os_sku_vendors').select(sql<number>`count(*)`.as('n')).where('vendor_id', '=', id).executeTakeFirst();
  const n = Number(used?.n ?? 0);
  if (n > 0) return reply.code(409).send({ success: false, message: `"${existing.name}" is assigned to ${n} product${n === 1 ? '' : 's'}; unassign them first` });
  await db.deleteFrom('os_vendors').where('id', '=', id).execute();
  reply.send({ success: true });
}

// POST /api/product/{id}/vendor {vendor_id}: assign (or clear with null/'') the product's vendor.
async function assignVendor(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = Number((req.params as Record<string, string>)['id']);
  const product = await db.selectFrom('os_products').select(['id', 'sku']).where('id', '=', id).executeTakeFirst();
  if (!product) return reply.code(404).send({ success: false, message: 'product not found' });
  const sku = clean(product.sku);
  if (sku === '') return reply.code(422).send({ success: false, message: 'product has no SKU' });
  const raw = input(req, 'vendor_id');
  if (raw === null || raw === undefined || clean(raw) === '' || clean(raw) === 'null') {
    await db.deleteFrom('os_sku_vendors').where('sku', '=', sku).execute();
    return reply.send({ success: true, vendor_id: null, vendor_name: null });
  }
  const vendorId = Number(raw);
  const vendor = Number.isInteger(vendorId) ? await db.selectFrom('os_vendors').select(['id', 'name']).where('id', '=', vendorId).executeTakeFirst() : undefined;
  if (!vendor) return reply.code(404).send({ success: false, message: 'vendor not found' });
  const now = nowDb();
  // sku is UNIQUE: one vendor per SKU, assigning again just moves it.
  await sql`insert into os_sku_vendors (sku, vendor_id, created_at, updated_at) values (${sku}, ${vendor.id}, ${now}, ${now})
    on duplicate key update vendor_id = values(vendor_id), updated_at = values(updated_at)`.execute(db);
  reply.send({ success: true, vendor_id: Number(vendor.id), vendor_name: vendor.name });
}

export function registerVendorRoutes(app: FastifyInstance): void {
  route(app, { verb: 'get', path: '/api/vendors', roles: ROLES, handler: apiList });
  route(app, { verb: 'post', path: '/api/vendors', roles: ROLES, handler: apiCreate });
  route(app, { verb: 'post', path: '/api/vendors/{id}', roles: ROLES, handler: apiUpdate });
  route(app, { verb: 'delete', path: '/api/vendors/{id}', roles: ROLES, handler: apiDelete });
  route(app, { verb: 'post', path: '/api/product/{id}/vendor', roles: ROLES, handler: assignVendor });
}
