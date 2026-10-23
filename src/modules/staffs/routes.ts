// StaffsController (routes/web.php:46 Route::resource, web + role:admin).
// Staff model has no $hidden/$appends, so show/edit serialise every column.
// The old controller flashes 'flash_message' (never read by any view) and
// redirects to 'admin/staffs' — a path with no route, faithfully reproduced.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Insertable } from 'kysely';
import { currentUser } from '../../auth.js';
import { db, nowDb, type OfficeDatabase } from '../../db.js';
import { allInput, lredirect } from '../../http.js';
import { resource } from '../../router.js';
import { render } from '../../view.js';

// The old views never read 'flash_message' (layout reads success/error/...), so
// this is an output no-op; kept for behavioural parity with Session::flash().
function flashMessage(req: FastifyRequest, value: string): void {
  const session = req.session as { get: (k: string) => unknown; set: (k: string, v: unknown) => void };
  const flash = (session.get('flash') ?? {}) as Record<string, unknown>;
  flash['flash_message'] = value;
  session.set('flash', flash);
}

function paramId(req: FastifyRequest): number {
  // SAFETY: the resource param is `{staff}` (singular of the base); fastify fills it
  // from the route path (e.g. /staffs/3). Laravel binds it to the method's $id by position.
  return Number((req.params as { staff: string }).staff);
}

// $request->all() filtered to the Staff $fillable columns (Eloquent mass-assignment).
const FILLABLE = ['compay_id', 'name', 'email', 'pin', 'status', 'CanBeTasked'] as const;
function pickFillable(all: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of FILLABLE) if (k in all) out[k] = all[k] === '' ? null : all[k];
  return out;
}

// Laravel validates name is required (whitespace-only fails the implicit rules too).
function nameError(all: Record<string, unknown>): string | null {
  const name = all['name'];
  return name === undefined || name === null || String(name).trim() === '' ? 'The name field is required.' : null;
}

// Staff::findOrFail($id) -> 404 when missing (surfaced by the router's not-found).
async function findStaff(id: number): Promise<Record<string, unknown>> {
  const row = await db.selectFrom('os_staffs').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw Object.assign(new Error('Staff not found'), { statusCode: 404 });
  return row as Record<string, unknown>;
}

export function registerStaffsRoutes(app: FastifyInstance): void {
  const middleware = ['web', 'role:admin'];

  resource(app, '/staffs', {
    // Staff::where('status','Active')->where('company_id', user.company_id)->get()
    index: async (req, reply) => {
      const auth = await currentUser(req);
      const company_id = auth.user?.company_id ?? null;
      const staffs =
        company_id === null
          ? []
          : await db
              .selectFrom('os_staffs')
              .selectAll()
              .where('status', '=', 'Active')
              .where('company_id', '=', company_id)
              .execute();
      await render(req, reply, 'staffs/index', { staffs });
    },
    create: async (req, reply) => {
      const auth = await currentUser(req);
      const company_id = auth.user?.company_id ?? null;
      await render(req, reply, 'staffs/create', { company_id });
    },
    store: async (req, reply) => {
      const all = allInput(req);
      const err = nameError(all);
      if (err) {
        reply.withErrors({ name: err }).withInput(all);
        return lredirect(req, reply, req.headers['referer'] ? String(req.headers['referer']) : '/');
      }
      // SAFETY: os_staffs.id is auto-increment, so it is omitted from the insert
      // even though the generated Kysely type marks it required.
      const values: Insertable<OfficeDatabase['os_staffs']> = {
        ...(pickFillable(all) as Record<string, unknown>),
        created_at: nowDb() as unknown as Date,
        updated_at: nowDb() as unknown as Date,
      } as unknown as Insertable<OfficeDatabase['os_staffs']>;
      await db.insertInto('os_staffs').values(values).execute();
      flashMessage(req, 'Staff added!');
      return lredirect(req, reply, 'admin/staffs');
    },
    show: async (req, reply) => {
      const staff = await findStaff(paramId(req));
      await render(req, reply, 'staffs/show', { staff });
    },
    edit: async (req, reply) => {
      const staff = await findStaff(paramId(req));
      await render(req, reply, 'staffs/edit', { staff });
    },
    update: async (req, reply) => {
      const id = paramId(req);
      const all = allInput(req);
      const err = nameError(all);
      if (err) {
        await findStaff(id); // findOrFail runs before validate in the PHP
        reply.withErrors({ name: err }).withInput(all);
        return lredirect(req, reply, req.headers['referer'] ? String(req.headers['referer']) : '/');
      }
      await findStaff(id);
      // SAFETY: nowDb() is the 'YYYY-MM-DD HH:mm:ss' string, not a Date.
      await db
        .updateTable('os_staffs')
        .set({ ...(pickFillable(all) as Record<string, unknown>), updated_at: nowDb() as unknown as Date })
        .where('id', '=', id)
        .execute();
      flashMessage(req, 'Staff updated!');
      return lredirect(req, reply, 'admin/staffs');
    },
    destroy: async (req, reply) => {
      await db.deleteFrom('os_staffs').where('id', '=', paramId(req)).execute();
      flashMessage(req, 'Staff deleted!');
      return lredirect(req, reply, 'admin/staffs');
    },
  }, { middleware });
}
