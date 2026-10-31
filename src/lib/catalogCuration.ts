// AI picks for catalog pages: one vision call per Faire product, cached in
// os_catalog_curation (scripts/sql/catalog-curation.sql). CATALOG_LLM_URL points
// at any OpenAI-compatible endpoint (a local llama-server); without it the call
// goes to api.openai.com. If neither is usable, the heuristic below still fills
// the page, so a catalog always renders.

import { openAiChat } from './chatService.js';
import { asJson, type CatalogLayout, type FaireRow } from './catalog.js';

export interface Candidate {
  url: string;
  width: number;
  height: number;
  tags: string[];
}

export interface Curation {
  hero: string;
  extras: string[];
  layout: CatalogLayout;
}

interface FaireImage {
  url?: string | null;
  width?: number | null;
  height?: number | null;
  tags?: string[] | null;
}

// Vision is the slow part; 6 images covers the median product and keeps a local
// model under ~15s per product.
const MAX_CANDIDATES = 6;
const SIZES: CatalogLayout[] = ['full', 'half', 'quarter'];
const SIZE_RANK: Record<CatalogLayout, number> = { full: 0, half: 1, quarter: 2 };

function imageList(value: unknown): FaireImage[] {
  const list = asJson<FaireImage[]>(value);
  return Array.isArray(list) ? list : [];
}

// Product images in Faire's sequence order, then one image per variant so each
// colour has a shot of its own, deduped and capped.
export function candidates(row: FaireRow): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (img: FaireImage | undefined): void => {
    const url = String(img?.url ?? '');
    if (!url || seen.has(url) || out.length >= MAX_CANDIDATES) return;
    seen.add(url);
    out.push({
      url,
      width: Number(img?.width) || 0,
      height: Number(img?.height) || 0,
      tags: Array.isArray(img?.tags) ? img?.tags : [],
    });
  };
  for (const img of imageList(row.images)) push(img);
  for (const variant of asJson<{ images?: unknown }[]>(row.variants) ?? []) push(imageList(variant?.images)[0]);
  return out;
}

// The smallest page slice this image can be shown in without being squeezed:
// photos are never cropped, so a tall one needs the height of a half or full page.
export function sizeFor(image: Candidate): CatalogLayout {
  const ratio = image.height / (image.width || image.height || 1);
  if (ratio >= 1.9) return 'full';
  return ratio >= 1.2 ? 'half' : 'quarter';
}

// Keeps a portrait photo out of a quarter cell; a bigger slice is always allowed.
function fitSize(image: Candidate, wanted: CatalogLayout): CatalogLayout {
  const floor = sizeFor(image);
  return SIZE_RANK[wanted] > SIZE_RANK[floor] ? floor : wanted;
}

export function heuristic(cands: Candidate[]): Curation {
  const hero = cands.find((c) => c.tags.includes('Hero')) ?? cands.find((c) => c.tags.includes('Product')) ?? cands[0];
  if (!hero) return { hero: '', extras: [], layout: 'half' };
  return { hero: hero.url, extras: cands.filter((c) => c.url !== hero.url).slice(0, 1).map((c) => c.url), layout: sizeFor(hero) };
}

// Chat Completions answers are a string, or an array of {text} parts.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => String((part as { text?: string }).text ?? '')).join('');
  return '';
}

// Accepts a JSON object, with or without code fences, and only image indices that
// exist. Returns null when the answer is unusable.
export function parseCuration(content: unknown, cands: Candidate[]): Curation | null {
  const found = textOf(content).match(/\{[\s\S]*\}/);
  const answer = found ? asJson<{ hero?: unknown; extras?: unknown; layout?: unknown }>(found[0]) : null;
  if (!answer) return null;
  const at = (value: unknown): Candidate | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? cands[value] : undefined;
  const hero = at(answer.hero);
  if (!hero) return null;
  const listed: unknown[] = Array.isArray(answer.extras) ? answer.extras : [];
  const extras = listed
    .map((v) => (typeof v === 'number' && v >= 0 ? cands[v] : undefined))
    .filter((c): c is Candidate => c !== undefined && c.url !== hero.url)
    .slice(0, 2)
    .map((c) => c.url);
  const wanted = SIZES.includes(answer.layout as CatalogLayout) ? (answer.layout as CatalogLayout) : sizeFor(hero);
  return { hero: hero.url, extras, layout: fitSize(hero, wanted) };
}

const PROMPT = (name: string, category: string, list: string): string =>
  `Pick catalog imagery for the wholesale product "${name}" (category: ${category}).
Answer with JSON only: {"hero": <index of the best cover image>, "extras": [<up to 2 supporting detail shots, never the hero>], "layout": "full" | "half" | "quarter"}
hero: exactly ONE photo of the ONE product being sold, whole, nothing cut off at the edge. Never pick a collage, a contact sheet of colour swatches, a grid of several views, or an image with dimension arrows, size labels, badges, price stickers, marketing text or a watermark. If every candidate is a collage or an annotated diagram, still answer with the plainest single-object photo. A plain background beats a lifestyle scene.
layout: how much of a printed catalog page this product deserves.
  "full" = the whole page: a flagship product, or a tall image that needs the height.
  "half" = half a page (two products on it): the normal choice.
  "quarter" = a quarter of a page (four products on it): only for a simple, small, low-detail product with a square or landscape photo.
Images (index: width x height, Faire's own tags):
${list}`;

export async function curateProduct(row: FaireRow): Promise<{ pick: Curation; model: string | null }> {
  const cands = candidates(row);
  const fallback = heuristic(cands);
  const url = process.env.CATALOG_LLM_URL || undefined;
  const model = process.env.CATALOG_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
  // CATALOG_LLM_EFFORT (e.g. xhigh) lets a local reasoning model think as long as it wants.
  const effort = process.env.CATALOG_LLM_EFFORT || undefined;
  if (cands.length === 0 || (!url && !process.env.OPENAI_API_KEY)) return { pick: fallback, model: null };

  const list = cands
    .map((c, i) => `${i}: ${c.width}x${c.height}${c.tags.length ? ' ' + c.tags.slice(0, 3).join(' ') : ''}`)
    .join('\n');
  try {
    const res = await openAiChat(
      {
        model,
        temperature: 0,
        // A local llama-server runs a reasoning model: without a thinking budget it
        // spends the whole token budget thinking and answers with nothing.
        ...(url
          ? effort
            ? { max_tokens: 8000, reasoning_effort: effort }
            : { max_tokens: 1500, reasoning_budget: 250 }
          : { max_completion_tokens: 900 }),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: PROMPT(
                  String(row.name ?? ''),
                  String(asJson<{ name?: string }>(row.taxonomy_type)?.name ?? 'unknown'),
                  list
                ),
              },
              ...cands.map((c) => ({ type: 'image_url', image_url: url ? { url: c.url } : { url: c.url, detail: 'low' } })),
            ],
          },
        ],
      },
      url,
      // A local llama-server queues concurrent requests, so a call can wait a
      // while before it starts generating.
      effort ? 600000 : 180000
    );
    const message = (res.choices as { message?: unknown }[] | undefined)?.[0]?.message as
      | { content?: unknown; reasoning_content?: unknown }
      | undefined;
    const pick = parseCuration(message?.content ?? message?.reasoning_content, cands);
    return pick ? { pick, model } : { pick: fallback, model: null };
  } catch (e) {
    // endpoint down, model without vision, or a bad answer
    console.warn('catalog curation fell back', { id: row.id, message: (e as Error).message.slice(0, 140) });
    return { pick: fallback, model: null };
  }
}
