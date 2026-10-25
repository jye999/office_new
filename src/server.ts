import fastifyStatic from '@fastify/static';
import fp from 'fastify-plugin';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { config } from './config.js';
import { db, sql } from './db.js';
import { registerViewPlugins, render } from './view.js';
import { registerHttpHelpers } from './http.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerApiAuthRoutes } from './modules/api/routes.js';
import { registerApiGuestRoutes } from './modules/auth/apiRoutes.js';
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
import { registerProductRoutes } from './modules/product/routes.js';
import { registerSupplierRoutes } from './modules/supplier/routes.js';
import { registerProductImageRoutes } from './modules/productimage/routes.js';
import { registerFaireImportRoutes } from './modules/faireimport/routes.js';
import { registerPdaRoutes } from './modules/pda/routes.js';
import { registerStampsRoutes } from './modules/stamps/routes.js';
import { registerFedexRoutes } from './modules/fedex/routes.js';
import { registerUpsRoutes } from './modules/ups/routes.js';
import { registerFrayunRoutes } from './modules/frayun/routes.js';
import { registerWayfairRoutes } from './modules/wayfair/routes.js';
import { registerTongtoolRoutes } from './modules/tongtool/routes.js';
import { registerEtsyRoutes } from './modules/etsy/routes.js';
import { registerEbayRoutes } from './modules/ebay/routes.js';
import { registerShopifyRoutes } from './modules/shopify/routes.js';
import { registerAmzadRoutes } from './modules/amzad/routes.js';
import { registerUnshippedRoutes } from './modules/unshipped/routes.js';
import { installRouter, preloadRouteTable } from './router.js';
import { registerSchedulerWhenEnabled } from './jobs/scheduler.js';

import { parseLaravelQuery } from './http.js';

export const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true }, querystringParser: parseLaravelQuery });

// T03: not-found handler (regex catch-alls + Laravel 404) must be installed
// before any root-level route registration.
installRouter(app);
// T10: named routes for modules not ported yet (e.g. nav's route('summary'))
// come from the static inventory so views emit the old app's URLs.
preloadRouteTable();

// fp() = global scope: form bodies must be parsed for routes registered on
// the root app (T02's auth module registered them after this plugin; without
// fp() the plugin is encapsulated and root routes 415 on urlencoded POSTs).
await app.register(fp(multipart), { attachFieldsToBody: false });
// T42: /ebayClosureNotification needs $request->getContent() (the RAW urlencoded
// body), so formbody is NOT registered here: this parser both captures the raw
// bytes on the request and hands them to the same parseLaravelQuery parser the
// app's querystringParser already uses (body and query share one parser).
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' },
  (_req, body, done) => {
    (_req as { rawBody?: string }).rawBody = body.toString();
    done(null, parseLaravelQuery(body.toString()));
  });
// registerHttpHelpers before the session plugin: its onSend must run first
// (onSend hooks are FIFO) so flashed errors/old input are consumed once.
await app.register(registerHttpHelpers);
await registerViewPlugins(app);
registerAuthRoutes(app);
registerApiAuthRoutes(app);
registerApiGuestRoutes(app);
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
registerProductRoutes(app);
registerSupplierRoutes(app);
registerProductImageRoutes(app);
registerFaireImportRoutes(app);
registerPdaRoutes(app);
registerStampsRoutes(app);
registerFedexRoutes(app);
registerUpsRoutes(app);
registerFrayunRoutes(app);
registerWayfairRoutes(app);
registerTongtoolRoutes(app);
registerEtsyRoutes(app);
registerEbayRoutes(app);
registerShopifyRoutes(app);
registerAmzadRoutes(app);
registerUnshippedRoutes(app);
await registerSchedulerWhenEnabled();

// Laravel renders uncaught exceptions through the app's own error view (old app
// ships resources/views/error/500.blade.php) — same as sendServer500.
app.setErrorHandler(async (err, req, reply) => {
  const e = err as { statusCode?: number; message: string };
  const status = Math.min(Math.max(e.statusCode ?? 500, 400), 599);
  if (status !== 500) return reply.code(status).send(e.message);
  console.error(`[500] ${req.method} ${req.url}:`, err); // Laravel logs these to storage/logs
  reply.code(500); // Laravel answers uncaught exceptions with HTTP 500, not 200
  await render(req, reply, 'error/500');
});

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

// ROUTES_CHECK=1 (scripts/routes-check.ts) imports this module only to read the registered routes.
if (process.env.ROUTES_CHECK !== '1') {
  app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
