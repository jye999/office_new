// Catalog builder: turns os_faire_products rows into print-style catalog pages
// (cover / contents / category divider / product spreads / back cover) for the
// /catalog/view flipbook. Pure — no DB and no templates, so it is unit-tested.

import { imageUrls } from './faireImageImporter.js';

// Columns the routes select from os_faire_products. JSON columns are already
// parsed by mysql2; a raw string is tolerated (as below).
export interface FaireRow {
  id: string;
  name: string | null;
  description: string | null;
  short_description: string | null;
  taxonomy_type: unknown;
  images: unknown;
  variants: unknown;
  minimum_order_quantity?: number | null;
  per_style_minimum_order_quantity?: number | null;
}

// Columns the catalog selects from os_faire_products (routes and the curation job).
export const FAIRE_COLUMNS = ['id', 'name', 'description', 'short_description', 'taxonomy_type', 'images', 'variants', 'minimum_order_quantity', 'per_style_minimum_order_quantity'] as const;

interface VariantPrices {
  wholesale_price_cents?: number | null;
  retail_price_cents?: number | null;
}
interface FaireVariant extends VariantPrices {
  sku?: string | null;
  name?: string | null;
  lifecycle_state?: string | null;
  sale_state?: string | null;
  options?: { name?: string | null; value?: string | null }[] | null;
  measurements?: {
    length?: number | null;
    width?: number | null;
    height?: number | null;
    weight?: number | null;
    distance_unit?: string | null;
    mass_unit?: string | null;
  } | null;
}

// How much of a page a product gets. A page is a 2x2 grid: full takes all four
// cells, half the top (or bottom) row, quarter one cell.
export type CatalogLayout = 'full' | 'half' | 'quarter';

const SIZES: CatalogLayout[] = ['full', 'half', 'quarter'];
// Rows curated before the size templates existed, mapped to the closest size.
const LEGACY_SIZES: Record<string, CatalogLayout> = { hero: 'full', duo: 'half', framed: 'half' };

function sizeOf(value: string | undefined): CatalogLayout {
  if (value && SIZES.includes(value as CatalogLayout)) return value as CatalogLayout;
  return LEGACY_SIZES[value ?? ''] ?? 'half';
}

// AI (or heuristic) image picks for one product; see catalogCuration.ts.
export interface ItemPick {
  hero?: string;
  extras?: string[];
  layout?: CatalogLayout;
}

export interface CatalogItem {
  // Faire product id and every photo it has, so the viewer can swap the shown image.
  id: string;
  images: string[];
  name: string;
  text: string;
  category: string;
  image: string;
  extras: string[];
  layout: CatalogLayout;
  sku: string;
  // One Faire product carries every colour/size as a variant: skus and colors
  // list all the sellable ones, sku is the first of them.
  skus: string[];
  colors: string[];
  // What `colors` lists: 'Colors', 'Sizes' or 'Options'.
  variantLabel: string;
  wholesale: string;
  dimensions: string[];
  weights: string[];
  // Faire's own minimum order, e.g. '4 pcs' or '4 pcs per style'.
  moq: string;
}

export interface CatalogPage {
  kind: 'cover' | 'contents' | 'category' | 'products' | 'back' | 'blank';
  title?: string;
  subtitle?: string;
  image?: string;
  // Product whose photo this page borrows (cover, category opener), so a swap follows it.
  imageId?: string;
  items?: CatalogItem[];
  contents?: { name: string; page: number }[];
}

export interface CatalogModel {
  pages: CatalogPage[];
  toc: { name: string; spread: number }[];
  count: number;
  categories: number;
}

export interface BuildOptions {
  title: string;
  subtitle: string;
  // faire product id -> skus, from os_faire_map, for Faire variants with no sku.
  skus?: Record<string, string[]>;
  // faire product id -> curated images + layout.
  picks?: Record<string, ItemPick>;
  // faire product id -> image chosen by hand in a saved draft; wins over the curated pick.
  overrides?: Record<string, string>;
}

const CELLS_BY_SIZE: Record<CatalogLayout, number> = { full: 4, half: 2, quarter: 1 };
const CELLS_PER_PAGE = 4;

// mysql2 hands JSON columns as objects; a raw string is decoded like PHP's json_decode.
export function asJson<T>(value: unknown): T | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return (value ?? null) as T | null;
}

// "$499" / "$11.98"; '' when unknown.
function money(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '';
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString('en-US')}`
    : `$${dollars.toFixed(2)}`;
}

// "$499" when one price, "$499 – $599" across variants.
function priceRange(min: number | null, max: number | null): string {
  if (min === null) return '';
  const lo = money(min);
  return max === null || max === min ? lo : `${lo} – ${money(max)}`;
}

function massUnit(m: NonNullable<FaireVariant['measurements']>): string {
  return m.mass_unit === 'KILOGRAMS' ? 'kg' : m.mass_unit === 'POUNDS' ? 'lb' : 'oz';
}

// '21″ L × 8″ W × 3″ H' — dimensions and weight are separate lines on the page.
function dimsOf(v: FaireVariant): string {
  const m = v.measurements;
  if (!m) return '';
  const unit = m.distance_unit === 'CENTIMETERS' ? 'cm' : '"';
  const parts: string[] = [];
  if (m.length) parts.push(`${m.length}${unit} L`);
  if (m.width) parts.push(`${m.width}${unit} W`);
  if (m.height) parts.push(`${m.height}${unit} H`);
  return parts.join(' × ');
}

function weightOf(v: FaireVariant): string {
  const m = v.measurements;
  if (!m?.weight) return '';
  return `${m.weight} ${massUnit(m)}`;
}

// Sellable variants first (Faire's own state fields); a product whose variants
// are all paused still gets a page, priced off whatever prices exist.
function pricedVariants(variants: FaireVariant[]): FaireVariant[] {
  const priced = variants.filter((v) => v.wholesale_price_cents != null || v.retail_price_cents != null);
  const sellable = priced.filter((v) => v.lifecycle_state === 'PUBLISHED' || v.sale_state === 'FOR_SALE');
  return sellable.length > 0 ? sellable : priced;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const TEXT_MAX = 260;
// How much copy a page cell has room for; a quarter cell shows none.
const TEXT_BY_SIZE: Record<CatalogLayout, number> = { full: 260, half: 125, quarter: 0 };

// Faire descriptions are bullet lists ("- Height: 21" - Material: PE"); set them as a run-in line.
function runIn(text: string): string {
  return text.replace(/^[-•]\s+/, '').replace(/\s[-•]\s+(?=[A-Z0-9])/g, ' · ');
}

// Cut at a sentence end if one is near, else at a word, so a description never stops mid-word.
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  const head = text.slice(0, max);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (stop > max * 0.5) return head.slice(0, stop + 1);
  return head.slice(0, head.lastIndexOf(' ')).replace(/[\s,;:–-]+$/, '') + '…';
}

// '4 pcs per style' when Faire sets a per-style minimum, '4 pcs' otherwise.
function moqOf(row: FaireRow): string {
  const qty = Number(row.minimum_order_quantity) || 0;
  if (qty <= 1) return '1 pc';
  const perStyle = Number(row.per_style_minimum_order_quantity) || 0;
  return `${qty} pcs${perStyle > 0 ? ' per style' : ''}`;
}

// What a variant is: its colour when it has one, else its size (or other option), else its name.
function colorOf(v: FaireVariant): string {
  const opts = v.options ?? [];
  const pick = opts.find((o) => /colou?r/i.test(String(o.name ?? ''))) ?? opts.find((o) => o.value);
  return oneLine(String(pick?.value ?? v.name ?? ''));
}

// Label for the variant row: "Colors", "Sizes", or plain "Options".
function variantLabelOf(variants: FaireVariant[]): string {
  const names = variants.flatMap((v) => v.options ?? []).map((o) => String(o.name ?? ''));
  if (names.some((n) => /colou?r/i.test(n))) return 'Colors';
  if (names.some((n) => /size|height|length|width|dimension/i.test(n))) return 'Sizes';
  return names.length ? 'Options' : 'Colors';
}

// Distinct non-empty values, in variant order.
function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

// Faire keeps several listings (different ids) for one product. They are one product in a
// catalog: group by name, keep the listing with the most variants, and fold the variants of
// the others into it so no colour or size is lost.
export function dedupeRows(rows: FaireRow[]): { rows: FaireRow[]; groups: Record<string, string[]> } {
  const key = (r: FaireRow): string => oneLine(String(r.name ?? '')).toLowerCase();
  const byName = new Map<string, FaireRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), r]);
  }
  const groups: Record<string, string[]> = {};
  const out: FaireRow[] = [];
  for (const list of byName.values()) {
    const variantsOf = (r: FaireRow): FaireVariant[] => asJson<FaireVariant[]>(r.variants) ?? [];
    const ranked = [...list].sort((a, b) => variantsOf(b).length - variantsOf(a).length || a.id.localeCompare(b.id));
    const rep = ranked[0];
    const seen = new Set<string>();
    const merged: FaireVariant[] = [];
    for (const v of ranked.flatMap(variantsOf)) {
      const id = oneLine(String(v.sku ?? v.name ?? '')).toLowerCase();
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      merged.push(v);
    }
    out.push(ranked.length > 1 ? { ...rep, variants: merged } : rep);
    groups[rep.id] = ranked.map((r) => r.id);
  }
  return { rows: out, groups };
}

export function catalogItem(row: FaireRow, fallbackSkus: string[] = [], pick: ItemPick = {}): CatalogItem | null {
  const name = oneLine(String(row.name ?? ''));
  if (!name) return null;
  const images = imageUrls(asJson<unknown>(row.images) ?? []);
  const variants = asJson<FaireVariant[]>(row.variants) ?? [];
  const sellable = pricedVariants(variants);
  const cents = (key: keyof VariantPrices): [number | null, number | null] => {
    const values = sellable
      .map((v) => v[key])
      .filter((v): v is number => typeof v === 'number');
    return values.length ? [Math.min(...values), Math.max(...values)] : [null, null];
  };
  const [whMin, whMax] = cents('wholesale_price_cents');
  const skus = unique(sellable.map((v) => oneLine(String(v.sku ?? '')))).length
    ? unique(sellable.map((v) => oneLine(String(v.sku ?? ''))))
    : unique(variants.map((v) => oneLine(String(v.sku ?? ''))).concat(fallbackSkus.map((s) => oneLine(String(s ?? '')))));
  // Faire's short_description is its own 75-character cut ending in "...", so the full
  // description is the better copy; the short one is the fallback.
  const full = oneLine(String(row.description ?? ''));
  const text = clip(runIn(full || oneLine(String(row.short_description ?? ''))), TEXT_MAX);
  return {
    id: row.id,
    images,
    name,
    text,
    category: oneLine(String((asJson<{ name?: string }>(row.taxonomy_type))?.name ?? 'More')),
    image: pick.hero || images[0] || '',
    extras: (pick.extras ?? []).filter((url) => url && url !== pick.hero && url !== images[0]).slice(0, 2),
    layout: sizeOf(pick.layout),
    sku: skus[0] ?? '',
    skus,
    colors: unique(sellable.map(colorOf)),
    variantLabel: variantLabelOf(sellable),
    wholesale: priceRange(whMin, whMax),
    dimensions: unique(sellable.map(dimsOf)).slice(0, 3),
    weights: unique(sellable.map(weightOf)).slice(0, 3),
    moq: moqOf(row),
  };
}

export function buildCatalog(allRows: FaireRow[], opts: BuildOptions): CatalogModel {
  const { rows, groups } = dedupeRows(allRows);
  // A duplicate's house skus and curated picks count for the product they were folded into.
  const skusFor = (id: string): string[] => [...new Set((groups[id] ?? [id]).flatMap((g) => opts.skus?.[g] ?? []))];
  const pickFor = (id: string): ItemPick => {
    const found = (groups[id] ?? [id]).map((g) => opts.picks?.[g]).filter((p): p is ItemPick => Boolean(p));
    return found.find((p) => p.hero) ?? {};
  };
  const items = rows
    .map((row) => catalogItem(row, skusFor(row.id), pickFor(row.id)))
    .filter((i): i is CatalogItem => i !== null);
  for (const item of items) {
    const chosen = opts.overrides?.[item.id];
    if (chosen) item.image = chosen;
  }

  const byCategory = new Map<string, CatalogItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  const categories = [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const list of byCategory.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const pages: CatalogPage[] = [
    { kind: 'cover', title: opts.title, subtitle: opts.subtitle, image: items[0]?.image ?? '', imageId: items[0]?.id },
    { kind: 'contents', contents: [] },
  ];
  const toc: { name: string; spread: number }[] = [];

  for (const [name, list] of categories) {
    const divider = pages.length; // 0-based index; contents shows the 1-based number
    pages.push({ kind: 'category', title: name, image: list[0]?.image ?? '', imageId: list[0]?.id });
    toc.push({ name, spread: Math.floor(divider / 2) });
    (pages[1].contents as { name: string; page: number }[]).push({ name, page: divider + 1 });
    // Fill each page's 2x2 grid in order: a bigger item starts a new page.
    let batch: CatalogItem[] = [];
    let cells = 0;
    // A short page grows its smaller items rather than showing empty cells.
    const grow = (list: CatalogItem[]): void => {
      let spare = CELLS_PER_PAGE - list.reduce((n, i) => n + CELLS_BY_SIZE[i.layout], 0);
      while (spare > 0) {
        const small = list
          .filter((i) => CELLS_BY_SIZE[i.layout] < CELLS_PER_PAGE)
          .sort((a, b) => CELLS_BY_SIZE[a.layout] - CELLS_BY_SIZE[b.layout])[0];
        if (!small) return;
        const cur = CELLS_BY_SIZE[small.layout];
        if (cur * 2 - cur > spare) return;
        small.layout = cur * 2 >= CELLS_PER_PAGE ? 'full' : 'half';
        spare -= cur;
      }
    };
    const flush = (): void => {
      if (batch.length > 0) {
        grow(batch);
        for (const item of batch) item.text = clip(item.text, TEXT_BY_SIZE[item.layout]);
        pages.push({ kind: 'products', title: name, items: batch });
      }
      batch = [];
      cells = 0;
    };
    for (const item of list) {
      const need = CELLS_BY_SIZE[item.layout];
      if (cells + need > CELLS_PER_PAGE) flush();
      batch.push(item);
      cells += need;
      if (cells >= CELLS_PER_PAGE) flush();
    }
    flush();
  }

  pages.push({ kind: 'back', title: opts.title });
  // The viewer spreads are pairs; a printed book has no loose last page.
  if (pages.length % 2 === 1) pages.push({ kind: 'blank' });

  return { pages, toc, count: items.length, categories: categories.length };
}
