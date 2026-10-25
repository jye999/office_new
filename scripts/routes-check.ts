// C1: compare plan/inventory.json against the routes registered on the Fastify app.
// Lists inventory routes (not excluded, not regex catch-alls) with no registered handler.
//
// Usage: pnpm routes:check   (exit 1 when any route is missing)

import fs from 'node:fs';
import path from 'node:path';

process.env.ROUTES_CHECK = '1';
process.env.SCHEDULER_ENABLED = '0';
const { app } = await import('../src/server.js');
const { toFastifyPath } = await import('../src/router.js');
const { db, hwc } = await import('../src/db.js');

interface InventoryRoute {
  verb: string;
  path: string;
  controller: string;
  action: string | null;
  excluded: boolean;
  where: string[] | null;
}

const inventory = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'plan', 'inventory.json'), 'utf8')) as { routes: InventoryRoute[] };

const RESOURCE_ACTIONS: [string, string][] = [
  ['GET', ''], ['GET', '/create'], ['POST', ''], ['GET', '/{id}'], ['GET', '/{id}/edit'], ['PUT', '/{id}'], ['PATCH', '/{id}'], ['DELETE', '/{id}'],
];
const ANY_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

await app.ready();

const missing: string[] = [];
let checked = 0;
let catchAll = 0;
let excluded = 0;
for (const r of inventory.routes) {
  if (r.excluded) { excluded++; continue; }
  if (r.where) { catchAll++; continue; } // regex catch-alls live in the not-found fallback
  const wanted: [string, string][] =
    r.verb === 'resource' ? RESOURCE_ACTIONS.map(([v, suffix]) => [v, r.path + suffix])
    : r.verb === 'any' ? ANY_VERBS.map((v) => [v, r.path])
    : [[r.verb.toUpperCase(), r.path]];
  for (const [method, laravelPath] of wanted) {
    checked++;
    // optional `{x?}` registers both forms; the first form (with the param) is enough to prove the handler
    const url = toFastifyPath(laravelPath)[0];
    if (!app.hasRoute({ method: method as 'GET', url })) missing.push(`${method} ${laravelPath}  (${r.controller}${r.action ? '@' + r.action : ''})`);
  }
}

console.log(`inventory routes: ${inventory.routes.length} (excluded ${excluded}, regex catch-alls ${catchAll}); verb+path checks: ${checked}`);
console.log(missing.length === 0 ? 'missing: none' : `missing (${missing.length}):\n${missing.map((m) => '  ' + m).join('\n')}`);

await app.close();
await db.destroy();
await hwc.destroy();
process.exit(missing.length === 0 ? 0 : 1);
