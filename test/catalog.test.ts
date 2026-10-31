// Catalog builder: pure page-composition checks. No DB, no templates.
import { describe, expect, it } from 'vitest';
import { buildCatalog, catalogItem, dedupeRows, type FaireRow } from '../src/lib/catalog.js';

function row(over: Partial<FaireRow>): FaireRow {
  return {
    id: 'p_1',
    name: 'Item',
    description: null,
    short_description: null,
    taxonomy_type: { name: 'Artificial Flowers' },
    images: [{ url: 'https://cdn.faire.com/a.jpeg', sequence: 0 }],
    variants: [{ sku: 'A1', wholesale_price_cents: 49900, retail_price_cents: 119800, lifecycle_state: 'PUBLISHED', sale_state: 'FOR_SALE' }],
    ...over,
  };
}

describe('catalogItem', () => {
  it('reads hero image, sku and prices from the Faire json', () => {
    const item = catalogItem(row({ name: 'Monstera Spray', short_description: 'Ten  leaves.' }));
    expect(item).toMatchObject({
      name: 'Monstera Spray',
      text: 'Ten leaves.',
      category: 'Artificial Flowers',
      image: 'https://cdn.faire.com/a.jpeg',
      sku: 'A1',
      wholesale: '$499',
    });
  });

  it('keeps dimensions, weight and the minimum order as separate facts', () => {
    const item = catalogItem(row({
      minimum_order_quantity: 4,
      variants: [
        {
          sku: 'A1',
          wholesale_price_cents: 49900,
          lifecycle_state: 'PUBLISHED',
          measurements: { length: 21, width: 8, height: 3, weight: 5, distance_unit: 'INCHES', mass_unit: 'OUNCES' },
        },
      ],
    }));
    expect(item).toMatchObject({ dimensions: ['21" L × 8" W × 3" H'], weights: ['5 oz'], moq: '4 pcs' });
    expect(catalogItem(row({ minimum_order_quantity: 6, per_style_minimum_order_quantity: 2 }))?.moq).toBe('6 pcs per style');
    expect(catalogItem(row({ minimum_order_quantity: 0 }))?.moq).toBe('');
  });

  it('lists every sellable colour and sku of a multi-variant product', () => {
    const item = catalogItem(row({
      variants: [
        { sku: 'R116OR', name: 'Sunrise Orange', options: [{ name: 'Color', value: 'Sunrise Orange' }], wholesale_price_cents: 1075, sale_state: 'FOR_SALE' },
        { sku: 'R116WT', name: 'White', options: [{ name: 'Color', value: 'White' }], wholesale_price_cents: 1175, sale_state: 'FOR_SALE' },
        { sku: 'R116AP', name: 'Apricot', options: [{ name: 'Color', value: 'Apricot' }], wholesale_price_cents: 900, sale_state: 'SALES_PAUSED' },
      ],
    }));
    expect(item).toMatchObject({
      sku: 'R116OR',
      skus: ['R116OR', 'R116WT'],
      colors: ['Sunrise Orange', 'White'],
      wholesale: '$10.75 – $11.75',
    });
  });

  it('falls back to os_faire_map skus and prices across variants', () => {
    const item = catalogItem(row({
      variants: [
        { wholesale_price_cents: 49900, retail_price_cents: 119800, lifecycle_state: 'PUBLISHED' },
        { wholesale_price_cents: 59900, retail_price_cents: 149800, lifecycle_state: 'PUBLISHED' },
        { wholesale_price_cents: 10000, lifecycle_state: 'UNPUBLISHED', sale_state: 'SALES_PAUSED' },
      ],
    }), ['MAPSKU', 'MAPSKU2']);
    expect(item).toMatchObject({ sku: 'MAPSKU', skus: ['MAPSKU', 'MAPSKU2'], wholesale: '$499 – $599' });
  });

  it('accepts raw json strings and drops unnamed rows', () => {
    expect(catalogItem(row({ images: '[{"url":"u","sequence":0}]', variants: '[{"wholesale_price_cents":500}]' }))?.image).toBe('u');
    expect(catalogItem(row({ name: '  ' }))).toBeNull();
  });
});

describe('buildCatalog', () => {
  const rows = [
    row({ id: 'a', name: 'B Bloom', taxonomy_type: { name: 'Bunting' } }),
    row({ id: 'b', name: 'A Apple', taxonomy_type: { name: 'Artificial Flowers' } }),
    row({ id: 'c', name: 'C Coral', taxonomy_type: { name: 'Artificial Flowers' } }),
  ];

  it('groups by category alphabetically and numbers the contents entries', () => {
    const model = buildCatalog(rows, { title: 'Spring', subtitle: 'Wholesale' });
    expect(model.count).toBe(3);
    expect(model.categories).toBe(2);
    expect(model.pages[0]).toMatchObject({ kind: 'cover', title: 'Spring', image: 'https://cdn.faire.com/a.jpeg' });
    expect(model.pages[1].contents).toEqual([
      { name: 'Artificial Flowers', page: 3 },
      { name: 'Bunting', page: 5 },
    ]);
    expect(model.pages.map((p) => p.kind)).toEqual([
      'cover', 'contents', 'category', 'products', 'category', 'products', 'back', 'blank',
    ]);
  });

  it('keeps an even page count and points toc spreads at the divider', () => {
    const model = buildCatalog(rows, { title: 'T', subtitle: '' });
    expect(model.pages.length % 2).toBe(0);
    expect(model.toc.map((t) => t.spread)).toEqual([1, 2]);
    expect(model.pages[3].items).toHaveLength(2);
  });

  it('still builds a usable book when nothing is sellable', () => {
    const model = buildCatalog([row({ variants: [] })], { title: 'T', subtitle: '' });
    expect(model.pages.map((p) => p.kind)).toEqual(['cover', 'contents', 'category', 'products', 'back', 'blank']);
    expect(model.pages[3].items?.[0]).toMatchObject({ wholesale: '', moq: '' });
  });
});

describe('dedupeRows', () => {
  const v = (sku: string) => ({ sku, wholesale_price_cents: 500, lifecycle_state: 'PUBLISHED', sale_state: 'FOR_SALE' });

  it('folds listings with the same name into one, keeping the one with most variants and every variant', () => {
    const a = row({ id: 'p_a', name: 'Fern  Bush', variants: [v('F1'), v('F2')] });
    const b = row({ id: 'p_b', name: 'fern bush', variants: [v('F2'), v('F3')] });
    const c = row({ id: 'p_c', name: 'Other', variants: [v('O1')] });
    const { rows, groups } = dedupeRows([b, c, a]);
    expect(rows.map((r) => r.id).sort()).toEqual(['p_a', 'p_c']);
    expect(groups['p_a']).toEqual(['p_a', 'p_b']);
    const fern = rows.find((r) => r.id === 'p_a')!;
    expect((fern.variants as { sku: string }[]).map((x) => x.sku).sort()).toEqual(['F1', 'F2', 'F3']);
  });

  it('shows a product once in the built catalog', () => {
    const model = buildCatalog([row({ id: 'p_a', name: 'Fern' }), row({ id: 'p_b', name: 'Fern' })], { title: 'T', subtitle: '' });
    expect(model.count).toBe(1);
  });
});
