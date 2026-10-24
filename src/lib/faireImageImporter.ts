// Port of app/Libraries/FaireImageImporter.php: pulls product images for
// os_faire_products variants (by sku) and stores them as os_product_images.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { db, nowDb } from '../db.js';
import { image } from '../images.js';
import { disk } from '../storage.js';

const MAX_IMAGES = 10;

type Row = Record<string, unknown>;

export interface DownloadedImage {
  contents: Buffer;
  ext: string;
  original_name: string;
}

export interface FaireJob {
  sku: string;
  image_urls: string[];
  faire_product_id: unknown;
}

export interface FaireSummary {
  dry_run: boolean;
  imported: number;
  replaced: number;
  skipped_no_sku: number;
  skipped_no_urls: number;
  not_found: number;
  errors: Row[];
  jobs: Row[];
}

// Test seam: replaces the curl download (returns null on failure).
type Downloader = (url: string) => Promise<DownloadedImage | null>;
let downloadOverride: Downloader | null = null;
export function setFaireDownloadForTests(fn: Downloader | null): void {
  downloadOverride = fn;
}

// PHP empty() for the values a JSON document can hold.
function phpEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === false || v === 0 || v === '' || v === '0' || (Array.isArray(v) && v.length === 0);
}

// json arrays and objects both decode to PHP arrays.
function isPhpArray(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null;
}

// mysql2 already parses JSON columns; PHP got the raw string.
function decodeJson(value: unknown): Record<string, unknown> | unknown[] {
  if (isPhpArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  if (typeof value !== 'string') return [];
  try {
    const decoded: unknown = JSON.parse(value);
    return isPhpArray(decoded) ? decoded : [];
  } catch {
    return [];
  }
}

function imageUrls(images: unknown): string[] {
  if (!isPhpArray(images)) return [];
  const list = Array.isArray(images) ? [...images] : Object.values(images);
  const seq = (x: unknown): number => {
    if (!isPhpArray(x) || Array.isArray(x)) return 0;
    const s = (x as Row)['sequence'];
    return s === undefined || s === null ? 0 : Math.trunc(Number(s)) || 0;
  };
  list.sort((a, b) => seq(a) - seq(b)); // stable like PHP 8; PHP 7.4's usort is stable for the small lists seen here
  const urls: string[] = [];
  for (const img of list) {
    if (isPhpArray(img) && !Array.isArray(img) && !phpEmptyValue((img as Row)['url'])) urls.push(String((img as Row)['url']));
  }
  return [...new Set(urls)];
}

export function jobsFromRows(rows: Row[], skuFilter: string | null = null): { jobs: FaireJob[]; skipped_no_sku: number; skipped_no_urls: number } {
  const jobs: FaireJob[] = [];
  const seen = new Set<string>();
  let skippedNoSku = 0;
  let skippedNoUrls = 0;
  for (const row of rows) {
    const images = decodeJson(row['images'] ?? null);
    const variants = decodeJson(row['variants'] ?? null);
    const productUrls = imageUrls(images);
    const faireId = row['id'] ?? null;
    for (const variant of Array.isArray(variants) ? variants : Object.values(variants)) {
      const v = isPhpArray(variant) && !Array.isArray(variant) ? (variant as Row) : {};
      const rawSku = v['sku'];
      const sku = rawSku === undefined || rawSku === null ? '' : String(rawSku).trim();
      if (sku === '') {
        skippedNoSku++;
        continue;
      }
      if (skuFilter !== null && skuFilter !== '' && sku !== skuFilter) continue;
      if (seen.has(sku)) continue;
      const variantUrls = imageUrls(v['images'] ?? []);
      const urls = (variantUrls.length > 0 ? variantUrls : productUrls).slice(0, MAX_IMAGES);
      if (urls.length === 0) {
        skippedNoUrls++;
        continue;
      }
      seen.add(sku);
      jobs.push({ sku, image_urls: urls, faire_product_id: faireId });
    }
  }
  return { jobs, skipped_no_sku: skippedNoSku, skipped_no_urls: skippedNoUrls };
}

// FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE for IPv4.
function isPublicIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 0 || a === 127 || a >= 240) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

async function isSafeUrl(url: string): Promise<boolean> {
  const scheme = /^([^:/?#]+):/.exec(url)?.[1];
  if (scheme !== 'http' && scheme !== 'https') return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  // gethostbynamel() is IPv4-only (and returns IP literals as-is).
  let ips: string[];
  if (isIP(host) === 4) ips = [host];
  else {
    try {
      ips = (await lookup(host, { family: 4, all: true })).map((r) => r.address);
    } catch {
      return false;
    }
  }
  return ips.length > 0 && ips.every(isPublicIpv4);
}

function extensionFromUrl(url: string): string {
  const ext = (/\.([^./]*)$/.exec(pathOf(url))?.[1] ?? '').toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'jpg';
  return ext === 'jpeg' ? 'jpg' : ext;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

async function downloadImage(url: string): Promise<DownloadedImage | null> {
  if (downloadOverride) return downloadOverride(url);
  if (!(await isSafeUrl(url))) {
    console.warn('Faire image rejected unsafe URL: ' + url);
    return null;
  }
  try {
    // redirect: 'manual' = CURLOPT_FOLLOWLOCATION 0 (a 3xx is a failure).
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'AngelOffice/1.0' }, signal: AbortSignal.timeout(30000) });
    if (res.status < 200 || res.status >= 300) {
      console.warn(`Faire image download failed: ${url} ${res.status}`);
      return null;
    }
    const base = pathOf(url).split('/').filter((s) => s !== '').pop() ?? ''; // basename()
    return { contents: Buffer.from(await res.arrayBuffer()), ext: extensionFromUrl(url), original_name: base };
  } catch (e) {
    console.warn(`Faire image download failed: ${url} ${String(e)}`);
    return null;
  }
}

async function deleteExisting(productId: number): Promise<void> {
  const images = await db.selectFrom('os_product_images').select(['id', 'filename']).where('product_id', '=', String(productId)).execute();
  for (const img of images) {
    await disk('product_image_full').delete(img.filename);
    await disk('product_image_icon').delete(img.filename);
    await db.deleteFrom('os_product_images').where('id', '=', img.id).execute();
  }
}

async function storeImage(productId: number, file: DownloadedImage, index: number): Promise<boolean> {
  try {
    const filePath = `${productId}_${Math.floor(Date.now() / 1000)}.${index}.${file.ext}`;
    await disk('product_image_full').put(filePath, await image(file.contents).widen(1000, (c) => c.upsize()).stream());
    await disk('product_image_icon').put(filePath, await image(file.contents).widen(100, (c) => c.upsize()).stream());
    // SAFETY: os_product_images column set + timestamps.
    await db
      .insertInto('os_product_images')
      .values({ product_id: String(productId), original_name: file.original_name, filename: filePath, created_at: nowDb(), updated_at: nowDb() } as never)
      .execute();
    return true;
  } catch (e) {
    console.error('Faire image store failed: ' + String(e));
    return false;
  }
}

export async function importFaireImages(skuFilter: string | null, dryRun: boolean): Promise<FaireSummary> {
  // SAFETY: selected columns of os_faire_products -> Record.
  const rows = (await db.selectFrom('os_faire_products').select(['id', 'name', 'images', 'variants']).execute()) as unknown as Row[];
  const parsed = jobsFromRows(rows, skuFilter);
  const summary: FaireSummary = {
    dry_run: dryRun,
    imported: 0,
    replaced: 0,
    skipped_no_sku: parsed.skipped_no_sku,
    skipped_no_urls: parsed.skipped_no_urls,
    not_found: 0,
    errors: [],
    jobs: [],
  };

  for (const job of parsed.jobs) {
    const product = await db.selectFrom('os_products').select(['id']).where('sku', '=', job.sku).executeTakeFirst();
    const entry: Row = {
      sku: job.sku,
      faire_product_id: job.faire_product_id,
      image_urls: job.image_urls,
      product_id: product ? product.id : null,
    };

    if (!product) {
      summary.not_found++;
      entry['status'] = 'not_found';
      summary.jobs.push(entry);
      continue;
    }

    if (dryRun) {
      entry['status'] = 'planned';
      summary.jobs.push(entry);
      continue;
    }

    const downloaded: DownloadedImage[] = [];
    for (const url of job.image_urls) {
      const file = await downloadImage(url);
      if (file === null) {
        summary.errors.push({ sku: job.sku, url, error: 'download_failed' });
        continue;
      }
      downloaded.push(file);
    }

    if (downloaded.length === 0) {
      entry['status'] = 'download_failed';
      summary.jobs.push(entry);
      continue;
    }

    const existing = await db.selectFrom('os_product_images').select(['id']).where('product_id', '=', String(product.id)).execute();
    const hadImages = existing.length > 0;
    await deleteExisting(product.id);

    let saved = 0;
    for (const [index, file] of downloaded.entries()) {
      if (await storeImage(product.id, file, index)) saved++;
      else summary.errors.push({ sku: job.sku, error: 'store_failed' });
    }

    entry['imported'] = saved;
    entry['status'] = saved > 0 ? 'imported' : 'store_failed';
    if (saved > 0) {
      summary.imported++;
      if (hadImages) summary.replaced++;
    }
    summary.jobs.push(entry);
  }

  return summary;
}
