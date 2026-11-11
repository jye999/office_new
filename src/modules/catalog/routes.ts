// Catalog maker: /catalog picks Faire products (os_faire_products) and
// /catalog/view renders the pick as a print-style flipbook (pages come from
// src/lib/catalog.ts). The viewer URL carries the ids, so a catalog is linkable
// and re-openable without a table of its own.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../db.js';
import { input, lredirect } from '../../http.js';
import { buildCatalog, catalogItem, dedupeRows, asJson, FAIRE_COLUMNS, type CatalogItem, type CatalogLayout, type FaireRow, type ItemPick } from '../../lib/catalog.js';
import { catalogJobStatus, dispatchCatalogCurate } from '../../jobs/queue.js';
import { curationTodo } from '../../lib/catalogCurateRun.js';
import { route } from '../../router.js';
import { render } from '../../view.js';

const ROLES = ['admin'];
const DEFAULT_TITLE = 'Wholesale Catalog';
const DEFAULT_BRAND = 'Enfloral';

const COLUMNS = FAIRE_COLUMNS;

interface PickerItem extends CatalogItem {
  id: string;
  published: boolean;
}

// ids[] (form checkboxes) or a comma-separated ids= list.
function idList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : String(value).split(',');
  const unique = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
  return unique;
}

async function text(req: FastifyRequest, key: string, fallback: string): Promise<string> {
  const value = String(input(req, key) ?? '').trim();
  return value || fallback;
}

// Faire's variant payload omits sku for some products; os_faire_map holds the
// house sku(s) for a Faire product (one row per sku, so a colour per line).
async function skusByFaireId(ids: string[]): Promise<Record<string, string[]>> {
  const mapped = await db
    .selectFrom('os_faire_map')
    .select(['faire_id', 'sku'])
    .where('faire_id', 'in', ids)
    .execute();
  const skus: Record<string, string[]> = {};
  for (const row of mapped) {
    if (!row.sku) continue;
    skus[row.faire_id] = [...(skus[row.faire_id] ?? []), row.sku];
  }
  return skus;
}

// Cached AI image picks (os_catalog_curation); uncached products use Faire's own
// sequence order.
async function picksByFaireId(ids: string[]): Promise<Record<string, ItemPick>> {
  const rows = await db
    .selectFrom('os_catalog_curation')
    .select(['faire_id', 'hero_url', 'extra_urls', 'layout'])
    .where('faire_id', 'in', ids)
    .execute();
  const picks: Record<string, ItemPick> = {};
  for (const row of rows) {
    picks[row.faire_id] = {
      hero: row.hero_url,
      extras: asJson<string[]>(row.extra_urls) ?? [],
      layout: row.layout as CatalogLayout,
    };
  }
  return picks;
}

// Curation runs in the worker (a local model takes seconds per product, so hundreds of
// products outlast any HTTP request): this queues the job and the page polls /catalog/curate/status.
async function curate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // formbody does not expand ids[] the way the query-string parser does.
  const ids = idList(input(req, 'ids') ?? input(req, 'ids[]'));
  if (ids.length === 0) return void reply.code(400).send({ ok: false, message: 'Select products first.' });
  const running = await catalogJobStatus();
  if (running) return void reply.send({ ok: true, job: running.id, total: running.total, already_running: true });
  const todo = await curationTodo(ids, String(input(req, 'force') ?? '') === '1');
  if (todo.length === 0) return void reply.send({ ok: true, job: null, total: 0, already_had: ids.length });
  const job = await dispatchCatalogCurate({ ids: todo });
  return void reply.send({ ok: true, job, total: todo.length, already_had: ids.length - todo.length });
}

async function curateStatus(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = String(input(req, 'job') ?? '').trim();
  const status = await catalogJobStatus(raw || undefined);
  reply.header('cache-control', 'no-store');
  return void reply.send({ ok: true, status });
}

// The mysql driver hands timestamps as Date or as 'YYYY-MM-DD HH:MM:SS' depending on dateStrings.
function stamp(value: Date | string | null): string {
  if (!value) return '';
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 16).replace('T', ' ');
}

async function picker(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Only published products are catalog material; Faire's repeat listings of one product count once.
  const all = (await db
    .selectFrom('os_faire_products')
    .select(COLUMNS)
    .where('lifecycle_state', '=', 'PUBLISHED')
    .orderBy('name', 'asc')
    .execute()) as FaireRow[];
  const rows = dedupeRows(all).rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const skus = await skusByFaireId(rows.map((r) => r.id));
  const picks = await picksByFaireId(rows.map((r) => r.id));
  const items: PickerItem[] = [];
  for (const row of rows) {
    const item = catalogItem(row, skus[row.id] ?? [], picks[row.id] ?? {});
    if (item) items.push({ ...item, id: row.id, published: true });
  }

  // Chrome would otherwise keep a heuristic copy of the HTML and show stale styling.
  reply.header('cache-control', 'no-store');
  await render(req, reply, 'catalog/index', {
    items,
    categories: [...new Set(items.map((i) => i.category))].sort((a, b) => a.localeCompare(b)),
    brand: await text(req, 'brand', DEFAULT_BRAND),
    title: await text(req, 'title', DEFAULT_TITLE),
    subtitle: await text(req, 'subtitle', ''),
    drafts: (await db.selectFrom('os_catalog_drafts').select(['id', 'name', 'updated_at']).orderBy('updated_at', 'desc').limit(20).execute())
      .map((d) => ({ id: d.id, name: d.name, updated: stamp(d.updated_at) })),
  });
}

interface Draft {
  id: number;
  name: string;
  title: string;
  brand: string;
  subtitle: string;
  ids: string[];
  overrides: Record<string, string>;
}

async function loadDraft(raw: unknown): Promise<Draft | null> {
  const id = Math.trunc(Number(raw));
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = await db.selectFrom('os_catalog_drafts').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    brand: row.brand,
    subtitle: row.subtitle,
    ids: asJson<string[]>(row.ids) ?? [],
    overrides: asJson<Record<string, string>>(row.overrides) ?? {},
  };
}

// Only http(s) image links are kept; a draft is rendered into <img src>.
function cleanOverrides(value: unknown): Record<string, string> {
  const parsed = asJson<Record<string, unknown>>(value) ?? {};
  const out: Record<string, string> = {};
  for (const [id, url] of Object.entries(parsed)) {
    const u = String(url ?? '').trim();
    if (/^https?:\/\//i.test(u) && u.length <= 600) out[id] = u;
  }
  return out;
}

// Create (no draft id) or update a draft from the viewer; answers { ok, id }.
async function saveDraft(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ids = idList(input(req, 'ids'));
  if (ids.length === 0) return void reply.code(400).send({ ok: false, message: 'Nothing to save.' });
  const title = await text(req, 'title', DEFAULT_TITLE);
  const values = {
    name: (await text(req, 'name', title)).slice(0, 160),
    title: title.slice(0, 160),
    brand: (await text(req, 'brand', DEFAULT_BRAND)).slice(0, 80),
    subtitle: (await text(req, 'subtitle', '')).slice(0, 200),
    ids: JSON.stringify(ids),
    overrides: JSON.stringify(cleanOverrides(input(req, 'overrides'))),
  };
  const existing = await loadDraft(input(req, 'draft'));
  if (existing) {
    await db.updateTable('os_catalog_drafts').set(values).where('id', '=', existing.id).execute();
    return void reply.send({ ok: true, id: existing.id });
  }
  const res = await db.insertInto('os_catalog_drafts').values(values).executeTakeFirst();
  return void reply.send({ ok: true, id: Number(res.insertId) });
}

// The picker posts its selection (a GET with hundreds of ids overflows nginx's URL limit), keeps
// it as a draft and sends the browser to the short ?draft= link.
async function openSelection(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ids = idList(input(req, 'ids') ?? input(req, 'ids[]'));
  if (ids.length === 0) {
    return void lredirect(req, reply.withErrors({ ids: 'Pick at least one product first.' }), '/catalog');
  }
  const title = (await text(req, 'title', DEFAULT_TITLE)).slice(0, 160);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const res = await db
    .insertInto('os_catalog_drafts')
    .values({
      name: `${title} ${stamp}`.slice(0, 160),
      title,
      brand: (await text(req, 'brand', DEFAULT_BRAND)).slice(0, 80),
      subtitle: (await text(req, 'subtitle', '')).slice(0, 200),
      ids: JSON.stringify(ids),
      overrides: '{}',
    })
    .executeTakeFirst();
  return void lredirect(req, reply, `/catalog/view?draft=${Number(res.insertId)}`);
}

async function deleteDraft(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const draft = await loadDraft(input(req, 'draft'));
  if (draft) await db.deleteFrom('os_catalog_drafts').where('id', '=', draft.id).execute();
  return void lredirect(req, reply, '/catalog');
}

async function viewer(req: FastifyRequest, reply: FastifyReply, publish = false): Promise<void> {
  const draft = await loadDraft(input(req, 'draft'));
  const ids = draft ? draft.ids : idList(input(req, 'ids'));
  if (ids.length === 0) {
    return void lredirect(req, reply.withErrors({ ids: 'Pick at least one product first.' }), '/catalog');
  }

  const chosen = (await db
    .selectFrom('os_faire_products')
    .select(COLUMNS)
    .where('id', 'in', ids)
    .where('lifecycle_state', '=', 'PUBLISHED')
    .execute()) as FaireRow[];
  // The other listings Faire holds for the same products fold into them (their colours and sizes count).
  const names = [...new Set(chosen.map((r) => r.name).filter((n): n is string => Boolean(n)))];
  const twins = names.length === 0 ? [] : ((await db
    .selectFrom('os_faire_products')
    .select(COLUMNS)
    .where('name', 'in', names)
    .where('id', 'not in', ids)
    .where('lifecycle_state', '=', 'PUBLISHED')
    .execute()) as FaireRow[]);
  const rows = [...chosen, ...twins];
  const allIds = rows.map((r) => r.id);

  const skus = await skusByFaireId(allIds);
  const picks = await picksByFaireId(allIds);

  const model = buildCatalog(rows, {
    title: draft?.title ?? (await text(req, 'title', DEFAULT_TITLE)),
    subtitle: draft?.subtitle ?? (await text(req, 'subtitle', '')),
    skus,
    picks,
    overrides: draft?.overrides,
  });

  reply.header('cache-control', 'no-store');
  // The published copy is a standalone index.html for a static host: no prices, no admin controls.
  if (publish) reply.header('content-disposition', 'attachment; filename="index.html"');
  await render(req, reply, 'catalog/flipbook', {
    publish,
    model,
    brand: draft?.brand ?? (await text(req, 'brand', DEFAULT_BRAND)),
    ids,
    draft: draft ? { id: draft.id, name: draft.name } : null,
    overrides: draft?.overrides ?? {},
    products: Object.fromEntries(
      model.pages.flatMap((pg) => pg.items ?? []).map((i) => [i.id, { name: i.name, images: i.images }]),
    ),
    title: model.pages[0]?.title ?? DEFAULT_TITLE,
    subtitle: model.pages[0]?.subtitle ?? '',
    year: String(new Date().getFullYear()),
  });
}

// Standalone, price-free copy of a saved draft, for hosting as a static website.
async function site(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  return viewer(req, reply, true);
}

export function registerCatalogRoutes(app: FastifyInstance): void {
  route(app, { verb: 'get', path: '/catalog', name: 'catalog', roles: ROLES, handler: picker });
  route(app, { verb: 'get', path: '/catalog/view', name: 'catalog.view', roles: ROLES, handler: viewer });
  route(app, { verb: 'get', path: '/catalog/site', name: 'catalog.site', roles: ROLES, handler: site });
  route(app, { verb: 'post', path: '/catalog/open', name: 'catalog.open', roles: ROLES, handler: openSelection });
  route(app, { verb: 'post', path: '/catalog/drafts', name: 'catalog.drafts.save', roles: ROLES, handler: saveDraft });
  route(app, { verb: 'post', path: '/catalog/drafts/delete', name: 'catalog.drafts.delete', roles: ROLES, handler: deleteDraft });
  route(app, { verb: 'get', path: '/catalog/curate/status', name: 'catalog.curate.status', roles: ROLES, handler: curateStatus });
  route(app, { verb: 'post', path: '/catalog/curate', name: 'catalog.curate', roles: ROLES, handler: curate });
}
