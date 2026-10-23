// ActionLogController (routes/web.php:428-429, web + role:admin,user,remote).
// store() returns nothing -> 200 with an empty body.

import type { FastifyInstance } from 'fastify';
import { currentUser } from '../../auth.js';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { render } from '../../view.js';

export function registerActionLogRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'get',
    path: '/actionLogs',
    name: 'actionLogs',
    middleware: ['web', 'role:admin,user,remote'],
    handler: async (req, reply) => {
      // ActionLog::orderBy('id', 'DESC')->take(1000)->get()
      const actionlogs = await db
        .selectFrom('os_action_log')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(1000)
        .execute();
      await render(req, reply, 'actionlogs/index', { actionlogs });
    },
  });

  route(app, {
    verb: 'post',
    path: '/actionLog',
    name: 'actionLog',
    middleware: ['web', 'role:admin,user,remote'],
    handler: async (req, reply) => {
      const auth = await currentUser(req);
      const ts = nowDb();
      // Eloquent $timestamps: insert sets created_at and updated_at.
      // SAFETY: Kysely types timestamp columns as Date, but mysql2 sends the
      // 'YYYY-MM-DD HH:mm:ss' string through unchanged (same value Laravel writes).
      await db
        .insertInto('os_action_log')
        .values({
          user_id: auth.user?.id ?? null,
          user_name: auth.user?.username ?? null,
          action: input(req, 'action') ?? null,
          created_at: ts as unknown as Date,
          updated_at: ts as unknown as Date,
        })
        .execute();
      reply.code(200).send('');
    },
  });
}
