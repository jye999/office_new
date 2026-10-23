import fastifyStatic from '@fastify/static';
import formbody from '@fastify/formbody';
import fp from 'fastify-plugin';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { config } from './config.js';
import { db, sql } from './db.js';
import { registerViewPlugins, render } from './view.js';
import { lredirect, registerHttpHelpers } from './http.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerApiAuthRoutes } from './modules/api/routes.js';
import { registerHomeRoutes } from './modules/home/routes.js';
import { registerActionLogRoutes } from './modules/actionlog/routes.js';
import { registerSettingsRoutes } from './modules/settings/routes.js';
import { registerTimesheetRoutes } from './modules/timesheet/routes.js';
import { registerStaffsRoutes } from './modules/staffs/routes.js';
import { registerExecRoutes } from './modules/exec/routes.js';
import { registerQueueJobRoutes } from './modules/queuejob/routes.js';
import { registerPriceRoutes } from './modules/price/routes.js';
import { registerMessageRoutes } from './modules/message/routes.js';
import { registerChatRoutes } from './modules/chat/routes.js';
import { registerGptRoutes } from './modules/gpt/routes.js';
import { registerKeywordsRoutes } from './modules/keywords/routes.js';
import { registerFbaRoutes } from './modules/fba/routes.js';
import { registerOpoloRoutes } from './modules/opolo/routes.js';
import { registerWindyRoutes } from './modules/windy/routes.js';
import { registerFourRoutes } from './modules/four/routes.js';
import { registerItemRoutes } from './modules/item/routes.js';
import { registerItemimageRoutes } from './modules/itemimage/routes.js';
import { registerFollowUpsRoutes } from './modules/followups/routes.js';
import { registerBulkProductionRoutes } from './modules/bulkproduction/routes.js';
import { registerProductionRoutes } from './modules/production/routes.js';
import { registerReportRoutes } from './modules/report/routes.js';
import { registerPurchaseRoutes } from './modules/purchase/routes.js';
import { registerInventoryRoutes } from './modules/inventory/routes.js';
import { registerOrderRoutes } from './modules/order/routes.js';
import { registerPdaRoutes } from './modules/pda/routes.js';
import { installRouter, preloadRouteTable } from './router.js';

// Laravel (Symfony Request) parses bracket notation in query strings into
// nested arrays/objects: `filter[name]=x&columns[0][data]=id` ->
// { filter: { name: 'x' }, columns: [{ data: 'id' }] }. Fastify's default
// parser keeps them as flat literal keys, which breaks every DataTables
// GET (T25b: inventory.transferdata). This mirrors the Laravel shape;
// flat keys are parsed exactly as before.
interface QueryObj {
  [key: string]: QueryValue;
}
type QueryValue = QueryObj | QueryValue[] | string;

function parseLaravelQuery(qs: string): QueryObj {
  const out: Record<string, unknown> = {};
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    const val = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    const m = /^([^\[\]]*)((\[[^\[\]]*\])*)$/.exec(key);
    if (!m || !m[2]) {
      out[key] = val;
      continue;
    }
    const segs = [m[1], ...[...m[2].matchAll(/\[([^\[\]]*)\]/g)].map((x) => x[1])];
    let node: Record<string, unknown> = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (typeof node[s] !== 'object' || node[s] === null) node[s] = {};
      node = node[s] as Record<string, unknown>;
    }
    node[segs[segs.length - 1]] = val;
  }
  // Consecutive integer keys become arrays (PHP lists).
  const toPhp = (v: unknown): QueryValue => {
    if (Array.isArray(v)) return v.map(toPhp);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length > 0 && keys.every((k, i) => k === String(i))) return keys.map((k) => toPhp(o[k]));
      for (const k of keys) o[k] = toPhp(o[k]);
    }
    return v as string;
  };
  return toPhp(out) as QueryObj;
}

const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true }, querystringParser: parseLaravelQuery });

// T03: not-found handler (regex catch-alls + Laravel 404) must be installed
// before any root-level route registration.
installRouter(app);
// T10: named routes for modules not ported yet (e.g. nav's route('summary'))
// come from the static inventory so views emit the old app's URLs.
preloadRouteTable();

// fp() = global scope: form bodies must be parsed for routes registered on
// the root app (T02's auth module registered them after this plugin; without
// fp() the plugin is encapsulated and root routes 415 on urlencoded POSTs).
await app.register(fp(formbody));
await app.register(fp(multipart), { attachFieldsToBody: false });
// registerHttpHelpers before the session plugin: its onSend must run first
// (onSend hooks are FIFO) so flashed errors/old input are consumed once.
await app.register(registerHttpHelpers);
await registerViewPlugins(app);
registerAuthRoutes(app);
registerApiAuthRoutes(app);
registerHomeRoutes(app);
registerActionLogRoutes(app);
registerSettingsRoutes(app);
registerTimesheetRoutes(app);
registerStaffsRoutes(app);
registerExecRoutes(app);
registerQueueJobRoutes(app);
registerPriceRoutes(app);
registerMessageRoutes(app);
registerChatRoutes(app);
registerGptRoutes(app);
registerKeywordsRoutes(app);
registerFbaRoutes(app);
registerOpoloRoutes(app);
registerWindyRoutes(app);
registerFourRoutes(app);
registerItemRoutes(app);
registerItemimageRoutes(app);
registerFollowUpsRoutes(app);
registerBulkProductionRoutes(app);
registerProductionRoutes(app);
registerReportRoutes(app);
registerPurchaseRoutes(app);
registerInventoryRoutes(app);
registerOrderRoutes(app);
registerPdaRoutes(app);

// T01 dev-only test route: renders a page extending `layout` (see views/layout-test.njk).
if (process.env.NODE_ENV !== 'production') {
  app.get('/__layout-test', async (req, reply) => {
    await render(req, reply, 'layout-test', { flash: 'yes' });
  });
}
await app.register(fastifyStatic, {
  root: config.PUBLIC_DIR,
  wildcard: true,
  decorateReply: true,
});

app.get('/__health', async () => {
  const { rows } = await sql<{ one: number }>`select 1 as one`.execute(db);
  return { ok: true, db: rows[0]?.one };
});

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
