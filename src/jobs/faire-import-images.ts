import { db, hwc } from '../db.js';

type Image = { url?: unknown; sequence?: unknown };
type Variant = { sku?: unknown; images?: unknown };
type FaireRow = { id: string; images: unknown; variants: unknown };
export type FaireImageJob = { sku: string; faire_product_id: string; image_urls: string[] };

function decode(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value === '') return [];
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) ? decoded : [];
  } catch {
    return [];
  }
}

function urls(value: unknown): string[] {
  return decode(value)
    .map((image, index) => ({ image: image as Image, index }))
    .sort((a, b) => Number(a.image.sequence ?? 0) - Number(b.image.sequence ?? 0) || a.index - b.index)
    .flatMap(({ image }) => typeof image.url === 'string' && image.url !== '' ? [image.url] : [])
    .filter((url, index, all) => all.indexOf(url) === index);
}

// FaireImageImporter::jobsFromRows(), including the first-SKU-wins behaviour.
export function faireImageJobs(rows: FaireRow[], skuFilter?: string): { jobs: FaireImageJob[]; skipped_no_sku: number; skipped_no_urls: number } {
  const jobs: FaireImageJob[] = [];
  const seen = new Set<string>();
  let skipped_no_sku = 0;
  let skipped_no_urls = 0;
  for (const row of rows) {
    const productUrls = urls(row.images);
    for (const variant of decode(row.variants) as Variant[]) {
      const sku = typeof variant.sku === 'string' ? variant.sku.trim() : '';
      if (sku === '') {
        skipped_no_sku++;
        continue;
      }
      if (skuFilter && sku !== skuFilter || seen.has(sku)) continue;
      const imageUrls = (urls(variant.images).length ? urls(variant.images) : productUrls).slice(0, 10);
      if (!imageUrls.length) {
        skipped_no_urls++;
        continue;
      }
      seen.add(sku);
      jobs.push({ sku, faire_product_id: row.id, image_urls: imageUrls });
    }
  }
  return { jobs, skipped_no_sku, skipped_no_urls };
}

export async function dryRunFaireImageImport(sku?: string) {
  const rows = await db.selectFrom('os_faire_products').select(['id', 'images', 'variants']).execute();
  // SAFETY: this projection has exactly the FaireRow columns, but generated Json types are wider than unknown.
  const parsed = faireImageJobs(rows as unknown as FaireRow[], sku);
  const jobs = [];
  let not_found = 0;
  for (const job of parsed.jobs) {
    const product = await db.selectFrom('os_products').select('id').where('sku', '=', job.sku).executeTakeFirst();
    if (!product) not_found++;
    jobs.push({ ...job, product_id: product?.id ?? null, status: product ? 'planned' : 'not_found' });
  }
  return { dry_run: true, imported: 0, replaced: 0, ...parsed, not_found, errors: [], jobs };
}

const args = process.argv.slice(2);
const sku = args.find((arg) => arg.startsWith('--sku='))?.slice(6);
try {
  // Safety boundary: this port never downloads or replaces image files in J1.
  const result = await dryRunFaireImageImport(sku);
  console.log('Dry run — no files will be written.');
  if (sku) console.log(`Filtering to SKU ${sku}`);
  console.log(`Imported: ${result.imported}`);
  console.log(`Replaced: ${result.replaced}`);
  console.log(`Not found: ${result.not_found}`);
  console.log(`Skipped (no SKU): ${result.skipped_no_sku}`);
  console.log(`Skipped (no URLs): ${result.skipped_no_urls}`);
  console.log(`Errors: ${result.errors.length}`);
  for (const job of result.jobs) console.log(`${job.sku}\t${job.status}\t${job.product_id ?? ''}\t${job.image_urls.length}`);
} finally {
  await db.destroy();
  await hwc.destroy();
}
