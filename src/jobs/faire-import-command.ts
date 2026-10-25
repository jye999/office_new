// `php artisan faire:import-images {--sku=} {--dry-run}` (app/Console/Commands/FaireImportImages.php).
// The download/replace work is FaireImageImporter (src/lib/faireImageImporter.ts); --dry-run only plans (read-only).

import { importFaireImages } from '../lib/faireImageImporter.js';
import { json_encode } from '../view.js';

export function parseFaireImportArgs(args: string[]): { sku: string | null; dryRun: boolean } {
  let sku = '';
  let dryRun = false;
  for (const [i, arg] of args.entries()) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--sku=')) sku = arg.slice('--sku='.length);
    else if (arg === '--sku') sku = args[i + 1] ?? '';
  }
  // PHP `$sku ?: null`: '' and '0' mean no filter.
  return { sku: sku === '' || sku === '0' ? null : sku, dryRun };
}

// Symfony Console's default table style.
function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const rule = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const line = (cells: string[]) => `| ${cells.map((cell, c) => cell.padEnd(widths[c])).join(' | ')} |`;
  return [rule, line(headers), rule, ...rows.map(line), rule];
}

export async function runFaireImportCommand(args: string[], out: (line: string) => void, err: (line: string) => void): Promise<void> {
  const { sku, dryRun: dryRunFlag } = parseFaireImportArgs(args);
  // DRY_RUN=1 (cutover rehearsal) forces the read-only plan even without --dry-run.
  const dryRun = dryRunFlag || process.env.DRY_RUN === '1';
  if (dryRun) out('Dry run — no files will be written.');
  if (sku) out(`Filtering to SKU ${sku}`);

  const summary = await importFaireImages(sku, dryRun);

  out(`Imported: ${summary.imported}`);
  out(`Replaced: ${summary.replaced}`);
  out(`Not found: ${summary.not_found}`);
  out(`Skipped (no SKU): ${summary.skipped_no_sku}`);
  out(`Skipped (no URLs): ${summary.skipped_no_urls}`);
  out(`Errors: ${summary.errors.length}`);
  const rows = summary.jobs.map((job) => [String(job['sku']), String(job['status'] ?? ''), job['product_id'] ? String(job['product_id']) : '', String((job['image_urls'] as unknown[]).length)]);
  if (rows.length > 0) for (const line of table(['SKU', 'Status', 'Product ID', 'URLs'], rows)) out(line);
  for (const error of summary.errors) err(json_encode(error));
}
