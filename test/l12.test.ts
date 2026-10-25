// L12: `pnpm faire:import-images` real path. The downloader is stubbed (no Faire URL is ever fetched), image files go to a
// temp STORAGE_DIR, and the ZZL12* products / faire rows are deleted afterwards. --dry-run must change nothing.
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const STORAGE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/l12-storage-${process.pid}`;
  process.env.STORAGE_DIR = dir;
  return dir;
});

import { db, nowDb } from '../src/db.js';
import { parseFaireImportArgs, runFaireImportCommand } from '../src/jobs/faire-import-command.js';
import { setFaireDownloadForTests } from '../src/lib/faireImageImporter.js';
import { disk } from '../src/storage.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const NOW = nowDb() as unknown as Date;
const SKU = 'ZZL12SKU';
const OTHER = 'ZZL12OTHER';
const FAIRE_ID = 'zzl12-faire';

let productId = 0;
let otherId = 0;
let downloads: string[];
let fetchSpy: ReturnType<typeof vi.spyOn>;

const run = async (...args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  await runFaireImportCommand(args, (l) => out.push(l), (l) => err.push(l));
  return { out, err };
};
const images = (id: number) => db.selectFrom('os_product_images').selectAll().where('product_id', '=', String(id)).execute();
const files = (diskName: string) => (fs.existsSync(`${STORAGE}/app/public/${diskName}`) ? fs.readdirSync(`${STORAGE}/app/public/${diskName}`) : []);

async function cleanup() {
  await db.deleteFrom('os_product_images').where('product_id', 'in', [String(productId), String(otherId)]).execute();
  await db.deleteFrom('os_products').where('sku', 'like', 'ZZL12%').execute();
  await db.deleteFrom('os_faire_products').where('id', '=', FAIRE_ID).execute();
}

beforeAll(async () => {
  await db.deleteFrom('os_products').where('sku', 'like', 'ZZL12%').execute();
  await db.deleteFrom('os_faire_products').where('id', '=', FAIRE_ID).execute();
  await db.insertInto('os_faire_products').values({
    id: FAIRE_ID,
    variants: JSON.stringify([
      { sku: SKU, images: [{ url: 'https://img.test/a/one.jpeg', sequence: 1 }, { url: 'https://img.test/a/two.png', sequence: 2 }] },
      { sku: OTHER, images: [{ url: 'https://img.test/a/other.png', sequence: 1 }] },
    ]),
    images: JSON.stringify([]),
  } as never).execute();
  productId = Number((await db.insertInto('os_products').values({ name: 'ZZL12 a', sku: SKU, created_at: NOW, updated_at: NOW } as never).executeTakeFirstOrThrow()).insertId);
  otherId = Number((await db.insertInto('os_products').values({ name: 'ZZL12 b', sku: OTHER, created_at: NOW, updated_at: NOW } as never).executeTakeFirstOrThrow()).insertId);
  await db.insertInto('os_product_images').values({ product_id: String(productId), original_name: 'old.jpg', filename: `${productId}_old.jpg`, created_at: NOW, updated_at: NOW } as never).execute();
  await disk('product_image_full').put(`${productId}_old.jpg`, PNG);
  await disk('product_image_icon').put(`${productId}_old.jpg`, PNG);
});
afterAll(async () => {
  await cleanup();
  fs.rmSync(STORAGE, { recursive: true, force: true });
});
afterEach(() => {
  setFaireDownloadForTests(null);
  delete process.env.DRY_RUN;
  vi.restoreAllMocks();
});

function stubDownloads() {
  downloads = [];
  setFaireDownloadForTests(async (url) => {
    downloads.push(url);
    return { contents: PNG, ext: url.endsWith('.jpeg') ? 'jpg' : 'png', original_name: url.split('/').pop() ?? '' };
  });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no real HTTP in tests'));
}

describe('faire:import-images command', () => {
  it('parses --sku=X / --sku X / --dry-run like the artisan signature; empty or 0 means no filter', () => {
    expect(parseFaireImportArgs(['--sku=A', '--dry-run'])).toEqual({ sku: 'A', dryRun: true });
    expect(parseFaireImportArgs(['--sku', 'B'])).toEqual({ sku: 'B', dryRun: false });
    expect(parseFaireImportArgs(['--sku=0'])).toEqual({ sku: null, dryRun: false });
    expect(parseFaireImportArgs([])).toEqual({ sku: null, dryRun: false });
  });

  it('--dry-run (and DRY_RUN=1 without the flag) prints the plan and writes nothing', async () => {
    stubDownloads();
    const before = await images(productId);
    for (const [args, env] of [[['--dry-run', `--sku=${SKU}`], false], [[`--sku=${SKU}`], true]] as const) {
      if (env) process.env.DRY_RUN = '1';
      const { out, err } = await run(...args);
      expect(out.slice(0, 2)).toEqual(['Dry run — no files will be written.', `Filtering to SKU ${SKU}`]);
      expect(out).toContain('Imported: 0');
      expect(out.join('\n')).toMatch(new RegExp(`\\| ${SKU} \\| planned \\| ${productId} +\\| 2 +\\|`));
      expect(err).toEqual([]);
    }
    expect(downloads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await images(productId)).toEqual(before);
    expect(files('product_images_full')).toEqual([`${productId}_old.jpg`]);
    expect(files('product_images_icon')).toEqual([`${productId}_old.jpg`]);
  });

  it('real run with --sku replaces that product\'s images (stubbed downloads) and leaves other SKUs alone', async () => {
    stubDownloads();
    const { out, err } = await run(`--sku=${SKU}`);
    expect(out).not.toContain('Dry run — no files will be written.');
    expect(out).toEqual(expect.arrayContaining(['Filtering to SKU ZZL12SKU', 'Imported: 1', 'Replaced: 1', 'Not found: 0', 'Errors: 0']));
    expect(err).toEqual([]);
    expect(downloads).toEqual(['https://img.test/a/one.jpeg', 'https://img.test/a/two.png']);
    const rows = await images(productId);
    expect(rows.map((r) => r.original_name)).toEqual(['one.jpeg', 'two.png']);
    expect(rows[0].filename).toMatch(new RegExp(`^${productId}_\\d+\\.0\\.jpg$`));
    expect(rows[1].filename).toMatch(new RegExp(`^${productId}_\\d+\\.1\\.png$`));
    expect(files('product_images_full').sort()).toEqual(rows.map((r) => r.filename).sort());
    expect(files('product_images_icon').sort()).toEqual(rows.map((r) => r.filename).sort());
    expect(await images(otherId)).toEqual([]);
  });

  it('prints download failures as JSON errors and keeps the existing images when nothing downloads', async () => {
    setFaireDownloadForTests(async () => null);
    const before = await images(productId);
    const { out, err } = await run(`--sku=${SKU}`);
    expect(out).toContain('Errors: 2');
    expect(err).toEqual([
      `{"sku":"${SKU}","url":"https:\\/\\/img.test\\/a\\/one.jpeg","error":"download_failed"}`,
      `{"sku":"${SKU}","url":"https:\\/\\/img.test\\/a\\/two.png","error":"download_failed"}`,
    ]);
    expect(out.join('\n')).toContain('download_failed');
    expect(await images(productId)).toEqual(before);
  });
});
