// FbaController (routes/web.php:321-324, all role:admin,user,remote).
//
// FbaHealth::all() / FbaAge::all() / AfnInventory::all() read os_FBA_HEALTH /
// os_FBA_AGE / os_AFN_INVENTORY (all present; models have no $hidden/$appends,
// so every column serialises). Orders uses raw SQL against os_FBA_ORDERS,
// which is missing from the shared DB, so it 500s in the old app (NOTES.md).

import type { FastifyInstance } from 'fastify';
import { db, sql } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { render, sendServer500 } from '../../view.js';

const MIDDLEWARE = ['web', 'role:admin,user,remote'];

export function registerFbaRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'get',
    path: '/FBA.Health',
    name: 'FBA.Health',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const fbaHealth = await db.selectFrom('os_FBA_HEALTH').selectAll().execute();
      await render(req, reply, 'fba/health', { fbaHealth });
    },
  });

  route(app, {
    verb: 'get',
    path: '/FBA.Age',
    name: 'FBA.Age',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const fbaAge = await db.selectFrom('os_FBA_AGE').selectAll().execute();
      await render(req, reply, 'fba/age', { fbaAge });
    },
  });

  route(app, {
    verb: 'get',
    path: '/FBA.Inventory',
    name: 'FBA.Inventory',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const fbaInventory = await db.selectFrom('os_AFN_INVENTORY').selectAll().execute();
      await render(req, reply, 'fba/inventory', { fbaInventory });
    },
  });

  // Orders: raw SQL (os_FBA_ORDERS, os_AFN_INVENTORY, os_grant_inventory).
  // Raw SQL is not os_-prefixed by Laravel — copied unchanged.
  route(app, {
    verb: 'get',
    path: '/FBA.Orders',
    name: 'FBA.Orders',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const rawDays = input(req, 'days');
      const days = rawDays === null ? 30 : Number(rawDays);
      try {
        // date("Y-m-d", strtotime('-<days> days')).
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const { rows } = await sql`select fo.sku,ai.asin,fo\`product-name\`,ogi.image, fo.qty from
(
    select sku,\`product-name\`,sum(\`quantity-shipped\`) qty
FROM \`os_FBA_ORDERS\`
where \`purchase-date\` >=${cutoff}
group by sku,\`product-name\`
) fo
left outer join (select DISTINCT asin, sku from \`os_AFN_INVENTORY\` ) ai
on fo.sku = ai.sku
left outer join (select distinct asin, sku,image from \`os_grant_inventory\`) ogi
on ai.sku = ogi.sku`.execute(db);
        await render(req, reply, 'fba/orders', { fbaOrders: rows, days });
      } catch {
        await sendServer500(req, reply);
      }
    },
  });
}
