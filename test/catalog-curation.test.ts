// Curation: how much page a product gets and which photo shows the whole product.
// The chat seam is stubbed, so nothing here reaches a model.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setOpenAiPostForTests } from '../src/lib/chatService.js';
import { candidates, curateProduct, heuristic, parseCuration, sizeFor } from '../src/lib/catalogCuration.js';
import { buildCatalog, type FaireRow } from '../src/lib/catalog.js';

function row(over: Partial<FaireRow>): FaireRow {
  return {
    id: 'p_1',
    name: 'Tulip Bud Bouquet',
    description: null,
    short_description: null,
    taxonomy_type: { name: 'Artificial Flowers' },
    images: [
      { url: 'https://cdn.faire.com/square.jpeg', sequence: 0, width: 2000, height: 2000, tags: ['Hero'] },
      { url: 'https://cdn.faire.com/tall.jpeg', sequence: 1, width: 1000, height: 1600, tags: ['Product'] },
      { url: 'https://cdn.faire.com/strip.jpeg', sequence: 2, width: 4000, height: 500, tags: ['Product'] },
    ],
    variants: [
      { sku: 'R116OR', images: [{ url: 'https://cdn.faire.com/orange.jpeg', sequence: 0, width: 1200, height: 1200, tags: ['Product'] }] },
      { sku: 'R116YL', images: [{ url: 'https://cdn.faire.com/square.jpeg', sequence: 0, width: 2000, height: 2000, tags: ['Hero'] }] },
    ],
    ...over,
  };
}

function answer(content: unknown): Record<string, unknown> {
  return { choices: [{ message: { content } }] };
}

describe('candidates', () => {
  it('keeps Faire order, adds one image per variant and dedupes', () => {
    expect(candidates(row({})).map((c) => c.url)).toEqual([
      'https://cdn.faire.com/square.jpeg',
      'https://cdn.faire.com/tall.jpeg',
      'https://cdn.faire.com/strip.jpeg',
      'https://cdn.faire.com/orange.jpeg',
    ]);
  });

  it('caps the list at 6', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ url: `u${i}`, sequence: i, width: 100, height: 100, tags: [] }));
    expect(candidates(row({ images: many })).length).toBe(6);
  });
});

describe('sizeFor', () => {
  const at = (width: number, height: number) => sizeFor({ url: 'u', width, height, tags: [] });

  it('sizes a photo by how tall it is, since photos are never cropped', () => {
    expect(at(1000, 1000)).toBe('quarter');
    expect(at(1000, 1400)).toBe('half');
    expect(at(1000, 2400)).toBe('full');
  });
});

describe('heuristic', () => {
  it('uses Faire\'s Hero tag and sizes it from the image shape', () => {
    expect(heuristic(candidates(row({})))).toEqual({
      hero: 'https://cdn.faire.com/square.jpeg',
      extras: ['https://cdn.faire.com/tall.jpeg'],
      layout: 'quarter',
    });
    expect(heuristic(candidates(row({ images: [{ url: 'tall', width: 1000, height: 2400, tags: ['Product'] }], variants: [] }))).layout).toBe('full');
    expect(heuristic([])).toEqual({ hero: '', extras: [], layout: 'half' });
  });
});

describe('parseCuration', () => {
  const cands = candidates(row({}));

  it('accepts fenced JSON and rejects indices that do not exist', () => {
    expect(parseCuration('```json\n{"hero": 1, "extras": [3, 9], "layout": "quarter"}\n```', cands)).toEqual({
      hero: 'https://cdn.faire.com/tall.jpeg',
      extras: ['https://cdn.faire.com/orange.jpeg'],
      layout: 'half', // the 1000x1600 photo cannot go in a quarter cell
    });
    expect(parseCuration('{"hero": 42}', cands)).toBeNull();
    expect(parseCuration('no json here', cands)).toBeNull();
  });

  it('never repeats the hero as an extra', () => {
    expect(parseCuration('{"hero": 0, "extras": [0, 1]}', cands)?.extras).toEqual(['https://cdn.faire.com/tall.jpeg']);
  });
});

describe('curateProduct', () => {
  const saved = { key: process.env.OPENAI_API_KEY, url: process.env.CATALOG_LLM_URL, model: process.env.CATALOG_LLM_MODEL };

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.CATALOG_LLM_URL;
    delete process.env.CATALOG_LLM_MODEL;
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = saved.key;
    process.env.CATALOG_LLM_URL = saved.url;
    process.env.CATALOG_LLM_MODEL = saved.model;
    setOpenAiPostForTests(null);
  });

  it('stores the model answer', async () => {
    let sent = '';
    setOpenAiPostForTests(async (body) => {
      sent = body;
      return answer('{"hero": 2, "extras": [1], "layout": "quarter"}');
    });
    const { pick, model } = await curateProduct(row({}));
    expect(pick).toEqual({ hero: 'https://cdn.faire.com/strip.jpeg', extras: ['https://cdn.faire.com/tall.jpeg'], layout: 'quarter' });
    expect(model).toBe(process.env.OPENAI_MODEL ?? 'gpt-4o');
    expect(sent).toContain('image_url');
    expect(sent).toContain('Tulip Bud Bouquet');
  });

  it('posts to the local model endpoint without needing an API key', async () => {
    let where = '';
    let sent = '';
    process.env.CATALOG_LLM_URL = 'http://100.71.42.40:8080/v1/chat/completions';
    process.env.CATALOG_LLM_MODEL = 'qwen3.8-flash-next-gyro-gyro-m';
    process.env.OPENAI_API_KEY = '';
    setOpenAiPostForTests(async (body, url) => {
      where = String(url);
      sent = body;
      return answer('{"hero": 1, "extras": [], "layout": "full"}');
    });
    const { pick, model } = await curateProduct(row({}));
    expect(where).toBe('http://100.71.42.40:8080/v1/chat/completions');
    expect(model).toBe('qwen3.8-flash-next-gyro-gyro-m');
    // A reasoning model without a thinking budget answers with nothing but its thinking.
    expect(sent).toContain('"reasoning_budget":250');
    expect(pick.layout).toBe('full');
  });

  it('reads the answer out of reasoning_content when content is empty', async () => {
    process.env.CATALOG_LLM_URL = 'http://x/v1/chat/completions';
    setOpenAiPostForTests(async () => ({ choices: [{ message: { content: '', reasoning_content: '{"hero": 0, "layout": "half"}' } }] }));
    expect((await curateProduct(row({}))).pick.hero).toBe('https://cdn.faire.com/square.jpeg');
  });

  it('falls back when the endpoint fails or the answer is unusable', async () => {
    setOpenAiPostForTests(async () => {
      throw new Error('request failed');
    });
    expect((await curateProduct(row({}))).pick.hero).toBe('https://cdn.faire.com/square.jpeg');

    setOpenAiPostForTests(async () => answer('I would pick the first photo.'));
    const { pick, model } = await curateProduct(row({}));
    expect(pick.layout).toBe('quarter');
    expect(model).toBeNull();
  });
});

describe('page composition by page size', () => {
  const items = [
    row({ id: 'a', name: 'A Item' }),
    row({ id: 'b', name: 'B Item' }),
    row({ id: 'c', name: 'C Item' }),
    row({ id: 'd', name: 'D Item' }),
    row({ id: 'e', name: 'E Item' }),
  ];
  const picks = {
    a: { hero: 'https://cdn.faire.com/square.jpeg', extras: [], layout: 'full' as const },
    b: { hero: 'https://cdn.faire.com/tall.jpeg', extras: [], layout: 'half' as const },
    c: { hero: 'https://cdn.faire.com/square.jpeg', extras: [], layout: 'quarter' as const },
    d: { hero: 'https://cdn.faire.com/square.jpeg', extras: [], layout: 'quarter' as const },
    e: { hero: 'https://cdn.faire.com/square.jpeg', extras: [], layout: 'half' as const },
  };

  it('fills each page with 4 cells and starts a new page when an item does not fit', () => {
    const model = buildCatalog(items, { title: 'T', subtitle: '', picks });
    const productPages = model.pages.filter((p) => p.kind === 'products').map((p) => p.items?.map((i) => i.layout).join('+'));
    expect(productPages).toEqual(['full', 'half+quarter+quarter', 'full']); // the lone half grows to a full page
  });

  it('puts two half-page items on one page when nothing is curated', () => {
    const model = buildCatalog(items, { title: 'T', subtitle: '' });
    expect(model.pages.filter((p) => p.kind === 'products').map((p) => p.items?.length)).toEqual([2, 2, 1]);
  });

  it('maps the old hero/duo/framed picks onto page sizes', () => {
    const legacy = { a: { hero: 'u', extras: [], layout: 'hero' as never } };
    const model = buildCatalog([items[0]], { title: 'T', subtitle: '', picks: legacy });
    expect(model.pages.find((p) => p.kind === 'products')?.items?.[0].layout).toBe('full');
  });
});
