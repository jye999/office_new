// QueueJobController (routes/web.php:407-410, 473 — all role:admin,user,remote).
// Relations are explicit queries (Eloquent hasMany/hasOne, no ORDER BY):
//   QueueJob.orders      -> os_queuejob_order where jobId = queueId
//   QueueJobOrder.order  -> os_grant_order where orderId (first)
//   GrantOrder.tracking  -> os_trackings where orderId

import type { FastifyInstance } from 'fastify';
import { db, nowDb, sql } from '../../db.js';
import { dispatchQueuePing } from '../../lib/queueJobs.js';
import { input, lredirect } from '../../http.js';
import { route } from '../../router.js';
import { render } from '../../view.js';

// stuck(): raw SQL is not os_-prefixed by Laravel — copied unchanged.
async function selectStuckOrders(): Promise<{ orderId: string; status: string | null }[]> {
  const { rows } = await sql<{ orderId: string; status: string | null }>`select distinct ogo.orderId,ogo.status from os_grant_order ogo where ogo.status='printing'`.execute(db);
  return rows;
}

export function registerQueueJobRoutes(app: FastifyInstance): void {
  const middleware = ['web', 'role:admin,user,remote'];

  // Route::get('/queue') -> index: latest 25 jobs (paginate(25); the view never
  // renders pagination links, so only the data rows are needed).
  route(app, {
    verb: 'get',
    path: '/queue',
    name: 'queue',
    middleware,
    handler: async (req, reply) => {
      const jobs = await db.selectFrom('os_queuejobs').selectAll().orderBy('id', 'desc').limit(25).execute();
      const rows: Record<string, unknown>[] = [];
      for (const job of jobs) {
        const orders = await db
          .selectFrom('os_queuejob_order')
          .selectAll()
          .where('jobId', '=', job.queueId)
          .execute();
        const cells: string[] = [];
        for (const o of orders) {
          // hasOne: the first grant_order with this orderId, if any. The old
          // view then dereferences $o->order unguarded (null -> empty href).
          const order = (
            await db.selectFrom('os_grant_order').select('orderId').where('orderId', '=', o.orderId).executeTakeFirst()
          ) as { orderId: string } | undefined;
          let cell = `<a href="/order/${order?.orderId ?? ''}/show" target="_blank">${o.orderId}</a> `;
          if (order) {
            const trackings = await db
              .selectFrom('os_trackings')
              .select('tracking')
              .where('orderId', '=', o.orderId)
              .execute();
            cell += trackings.length > 0 ? `${trackings[0].tracking}<br>` : 'no tracking<br>';
          } else {
            cell += 'no tracking<br>';
          }
          cells.push(cell);
        }
        // PHP echoes the cells back-to-back; join with '' so the view can emit them as one safe block.
        rows.push({ ...job, orders: cells.join('') });
      }
      await render(req, reply, 'queuejob/index', { title: 'Index - queue jobs', jobs: rows });
    },
  });

  // Route::get('/queue.print') -> print: label <img> tags per order of a queue.
  // $is_pdf is never set true in the PHP (dead branch); no queueId / unknown
  // queue -> Laravel returns null -> empty 200 body.
  route(app, {
    verb: 'get',
    path: '/queue.print',
    name: 'queue.print',
    middleware,
    handler: async (req, reply) => {
      const queueId = input(req, 'queueId');
      if (queueId === null || queueId === '') return reply.send('');
      const queue = await db
        .selectFrom('os_queuejobs')
        .select('queueId')
        .where('queueId', '=', Number(queueId))
        .executeTakeFirst();
      if (!queue) return reply.send('');
      const orders = await db.selectFrom('os_queuejob_order').selectAll().where('jobId', '=', queue.queueId).execute();
      let html = "<html><body><style>.break { page-break-before: always; }</style>";
      let first = true;
      for (const o of orders) {
        const tracking = (
          await db.selectFrom('os_trackings').select('Id').where('orderId', '=', o.orderId).executeTakeFirst()
        ) as { Id: number } | undefined;
        if (tracking) {
          html += first ? '' : "<p class='break'>&nbsp;</p>";
          first = false;
          html += `<img src='/getOrderLabel?orderId=${o.orderId}'  style='width: 3.812in;height: 5.718in;' />`;
        }
      }
      html += '</body></html>';
      return reply.type('text/html; charset=UTF-8').send(html);
    },
  });

  // Route::get('/queue.stuck') -> stuck.
  route(app, {
    verb: 'get',
    path: '/queue.stuck',
    name: 'queue.stuck',
    middleware,
    handler: async (req, reply) => {
      const stuckOrders = await selectStuckOrders();
      await render(req, reply, 'queuejob/stuck', { stuckOrders, title: 'Stuck orders' });
    },
  });

  // Route::get('/queue.reset_stuck') -> resetStuck: clear status on the
  // matching grant orders (Eloquent save() sets updated_at).
  route(app, {
    verb: 'get',
    path: '/queue.reset_stuck',
    name: 'queue.reset_stuck',
    middleware,
    handler: async (req, reply) => {
      for (const o of await selectStuckOrders()) {
        const job = await db
          .selectFrom('os_grant_order')
          .select('id')
          .where('orderId', '=', o.orderId)
          .executeTakeFirst();
        if (job) {
          // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string, not a Date; the
          // column is a timestamp and mysql2 stores the string unchanged.
          const ts = nowDb() as unknown as Date;
          await db
            .updateTable('os_grant_order')
            .set({ status: null, updated_at: ts })
            .where('id', '=', job.id)
            .execute();
        }
      }
      return lredirect(req, reply, '/queue.stuck');
    },
  });

  // Route::get('/queue.ping') -> PingQueue. The BullMQ worker inserts the
  // QueuePing row and fires no observable event (QueuePingEvent has no listeners).
  route(app, {
    verb: 'get',
    path: '/queue.ping',
    name: 'queue.ping',
    middleware,
    handler: async (req, reply) => {
      await dispatchQueuePing('hello');
      return lredirect(req, reply, '/queue');
    },
  });
}
