// Catalog maker: /catalog picks Faire products (os_faire_products) and
// /catalog/view renders the pick as a print-style flipbook (pages come from
// src/lib/catalog.ts). The viewer URL carries the ids, so a catalog is linkable
// and re-openable without a table of its own.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../db.js';
import { input, lredirect } from '../../http.js';
import { buildCatalog, catalogItem, asJson, type CatalogItem, type CatalogLayout, type FaireRow, type ItemPick } from '../../lib/catalog.js';
import { curateProduct } from '../../lib/catalogCuration.js';
import { route } from '../../router.js';
import { render } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];
// shortcut: URL-length guard on the ?ids= list; raise if a catalog ever needs more.
const MAX_ITEMS = 250;
const DEFAULT_TITLE = 'Wholesale Catalog';
const DEFAULT_BRAND = 'Enfloral';

const COLUMNS = ['id', 'name', 'description', 'short_description', 'taxonomy_type', 'images', 'variants', 'minimum_order_quantity', 'per_style_minimum_order_quantity'] as const;

interface PickerItem extends CatalogItem {
  id: string;
  published: boolean;
}

// ids[] (form checkboxes) or a comma-separated ids= list.
function idList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : String(value).split(',');
  const unique = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
  return unique.slice(0, MAX_ITEMS);
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

// Small bounded map: OpenAI answers in ~2-4s, and 4 at a time is polite.
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map((item) => fn(item)));
  }
}

async function curate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // formbody does not expand ids[] the way the query-string parser does.
  const ids = idList(input(req, 'ids') ?? input(req, 'ids[]'));
  if (ids.length === 0) return void reply.code(400).send({ ok: false, message: 'Select products first.' });
  const force = String(input(req, 'force') ?? '') === '1';
  const have = await db.selectFrom('os_catalog_curation').select('faire_id').where('faire_id', 'in', ids).execute();
  const known = new Set(have.map((h) => h.faire_id));
  const todo = force ? ids : ids.filter((id) => !known.has(id));
  // MySQL rejects "in ()", and there is nothing to ask the model about anyway.
  if (todo.length === 0) return void reply.send({ ok: true, curated: 0, from_model: 0, already_had: ids.length });

  const rows = (await db
    .selectFrom('os_faire_products')
    .select(COLUMNS)
    .where('id', 'in', todo)
    .execute()) as FaireRow[];

  let curated = 0;
  let fromModel = 0;
  // shortcut: 4 in flight is tuned for throughput, but a local llama-server still
  // takes ~15s per product, so hundreds of products take tens of minutes.
  // Upgrade to a background job if that gets annoying.
  await mapLimit(rows, 4, async (row) => {
    const { pick, model } = await curateProduct(row);
    if (!pick.hero) return;
    await db
      .insertInto('os_catalog_curation')
      .values({ faire_id: row.id, hero_url: pick.hero, extra_urls: JSON.stringify(pick.extras), layout: pick.layout, model })
      .onDuplicateKeyUpdate({ hero_url: pick.hero, extra_urls: JSON.stringify(pick.extras), layout: pick.layout, model })
      .execute();
    curated += 1;
    if (model) fromModel += 1;
  });

  return void reply.send({ ok: true, curated, from_model: fromModel, already_had: ids.length - todo.length });
}

async function picker(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Unpublished Faire products are hidden unless ?all=1 asks for them.
  const showAll = String(input(req, 'all') ?? '') === '1';
  const rows = (await db
    .selectFrom('os_faire_products')
    .select([...COLUMNS, 'lifecycle_state'])
    .orderBy('name', 'asc')
    .execute()) as (FaireRow & { lifecycle_state: string | null })[];

  const skus = await skusByFaireId(rows.map((r) => r.id));
  const picks = await picksByFaireId(rows.map((r) => r.id));
  const items: PickerItem[] = [];
  for (const row of rows) {
    const item = catalogItem(row, skus[row.id] ?? [], picks[row.id] ?? {});
    if (!item) continue;
    // Paused stock is still a product the shop sells; DRAFT/UNPUBLISHED is not,
    // and those come in only with ?all=1.
    const published = row.lifecycle_state === 'PUBLISHED';
    if (published || showAll) items.push({ ...item, id: row.id, published });
  }

  // Chrome would otherwise keep a heuristic copy of the HTML and show stale styling.
  reply.header('cache-control', 'no-store');
  await render(req, reply, 'catalog/index', {
    items,
    categories: [...new Set(items.map((i) => i.category))].sort((a, b) => a.localeCompare(b)),
    brand: await text(req, 'brand', DEFAULT_BRAND),
    title: await text(req, 'title', DEFAULT_TITLE),
    subtitle: await text(req, 'subtitle', ''),
    showAll,
    drafts: (await db.selectFrom('os_catalog_drafts').select(['id', 'name', 'updated_at']).orderBy('updated_at', 'desc').limit(20).execute())
      .map((d) => ({ id: d.id, name: d.name, updated: d.updated_at ? d.updated_at.toISOString().slice(0, 16).replace('T', ' ') : '' })),
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

async function deleteDraft(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const draft = await loadDraft(input(req, 'draft'));
  if (draft) await db.deleteFrom('os_catalog_drafts').where('id', '=', draft.id).execute();
  return void lredirect(req, reply, '/catalog');
}

async function viewer(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const draft = await loadDraft(input(req, 'draft'));
  const ids = draft ? draft.ids : idList(input(req, 'ids'));
  if (ids.length === 0) {
    return void lredirect(req, reply.withErrors({ ids: 'Pick at least one product first.' }), '/catalog');
  }

  const rows = (await db
    .selectFrom('os_faire_products')
    .select(COLUMNS)
    .where('id', 'in', ids)
    .execute()) as FaireRow[];

  const skus = await skusByFaireId(ids);
  const picks = await picksByFaireId(ids);

  const model = buildCatalog(rows, {
    title: draft?.title ?? (await text(req, 'title', DEFAULT_TITLE)),
    subtitle: draft?.subtitle ?? (await text(req, 'subtitle', '')),
    skus,
    picks,
    overrides: draft?.overrides,
  });

  reply.header('cache-control', 'no-store');
  await render(req, reply, 'catalog/flipbook', {
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

export function registerCatalogRoutes(app: FastifyInstance): void {
  route(app, { verb: 'get', path: '/catalog', name: 'catalog', roles: ROLES, handler: picker });
  route(app, { verb: 'get', path: '/catalog/view', name: 'catalog.view', roles: ROLES, handler: viewer });
  route(app, { verb: 'post', path: '/catalog/drafts', name: 'catalog.drafts.save', roles: ROLES, handler: saveDraft });
  route(app, { verb: 'post', path: '/catalog/drafts/delete', name: 'catalog.drafts.delete', roles: ROLES, handler: deleteDraft });
  route(app, { verb: 'post', path: '/catalog/curate', name: 'catalog.curate', roles: ROLES, handler: curate });
}
