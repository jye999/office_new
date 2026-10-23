// SettingsController (routes/web.php:266 Route::resource, 268-269;
// web + role:admin,user,remote). The old controller only defines
// index/savePackingText/saveQuickSearch; the other six resource actions 500
// (missing method). /api/settings/* belong to T02 (src/modules/api/routes.ts).

import type { FastifyInstance } from 'fastify';
import { db, nowDb } from '../../db.js';
import { allInput } from '../../http.js';
import { resource, route } from '../../router.js';
import { render, sendServer500 } from '../../view.js';

// Setting::where('name','=',$name) upsert: insert (both timestamps) when the row
// is missing, else set value + updated_at. save() returns nothing.
async function saveSetting(name: string, value: unknown): Promise<void> {
  const ts = nowDb();
  const existing = await db
    .selectFrom('os_settings')
    .select('id')
    .where('name', '=', name)
    .executeTakeFirst();
  // SAFETY: Kysely types timestamp columns as Date, but mysql2 sends the
  // 'YYYY-MM-DD HH:mm:ss' string through unchanged (same value Laravel writes).
  if (existing) {
    await db
      .updateTable('os_settings')
      .set({ value: String(value), updated_at: ts as unknown as Date })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('os_settings')
      .values({ name, value: String(value), created_at: ts as unknown as Date, updated_at: ts as unknown as Date })
      .execute();
  }
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  resource(app, '/Settings', {
    // Setting::where('name', '=', 'QuickSearch')->first()
    index: async (req, reply) => {
      const settings = await db
        .selectFrom('os_settings')
        .selectAll()
        .where('name', '=', 'QuickSearch')
        .executeTakeFirst();
      await render(req, reply, 'settings', { settings });
    },
    // create/store/show/edit/update/destroy do not exist on the old controller.
    create: sendServer500,
    store: sendServer500,
    show: sendServer500,
    edit: sendServer500,
    update: sendServer500,
    destroy: sendServer500,
  }, { middleware: ['web', 'role:admin,user,remote'] });

  route(app, {
    verb: 'post',
    path: '/Settings.savePackingText',
    name: 'Settings.savePackingText',
    middleware: ['web', 'role:admin,user,remote'],
    handler: async (req, reply) => {
      const data = allInput(req);
      if ('packingText' in data) await saveSetting('PackingText', data['packingText']);
      reply.code(200).send('');
    },
  });

  route(app, {
    verb: 'post',
    path: '/Settings.saveQuickSearch',
    name: 'Settings.saveQuickSearch',
    middleware: ['web', 'role:admin,user,remote'],
    handler: async (req, reply) => {
      const data = allInput(req);
      if ('quickSearch' in data) await saveSetting('QuickSearch', data['quickSearch']);
      reply.code(200).send('');
    },
  });
}
