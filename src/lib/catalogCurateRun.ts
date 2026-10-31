// Bulk catalog curation, run by the worker (jobs/catalogJob.ts): one vision call per
// Faire product, cached in os_catalog_curation. Progress is reported after each batch
// so the picker page can show "34 / 340".

import { db } from '../db.js';
import { FAIRE_COLUMNS, type FaireRow } from './catalog.js';
import { curateProduct } from './catalogCuration.js';

export interface CurateProgress {
  total: number;
  done: number;
  curated: number;
  fromModel: number;
}

// shortcut: 4 in flight suits a local llama-server queue; raise if the endpoint scales.
const PARALLEL = 4;

// Ids not yet curated (all of them when force is set).
export async function curationTodo(ids: string[], force: boolean): Promise<string[]> {
  if (force || ids.length === 0) return ids;
  const have = await db.selectFrom('os_catalog_curation').select('faire_id').where('faire_id', 'in', ids).execute();
  const known = new Set(have.map((h) => h.faire_id));
  return ids.filter((id) => !known.has(id));
}

export async function runCuration(
  ids: string[],
  onProgress: (p: CurateProgress) => Promise<void> | void = () => undefined
): Promise<CurateProgress> {
  const progress: CurateProgress = { total: ids.length, done: 0, curated: 0, fromModel: 0 };
  for (let i = 0; i < ids.length; i += PARALLEL) {
    const chunk = ids.slice(i, i + PARALLEL);
    const rows = (await db.selectFrom('os_faire_products').select(FAIRE_COLUMNS).where('id', 'in', chunk).execute()) as FaireRow[];
    await Promise.all(
      rows.map(async (row) => {
        const { pick, model } = await curateProduct(row);
        if (!pick.hero) return;
        const values = { hero_url: pick.hero, extra_urls: JSON.stringify(pick.extras), layout: pick.layout, model };
        await db
          .insertInto('os_catalog_curation')
          .values({ faire_id: row.id, ...values })
          .onDuplicateKeyUpdate(values)
          .execute();
        progress.curated += 1;
        if (model) progress.fromModel += 1;
      })
    );
    progress.done += chunk.length;
    await onProgress({ ...progress });
  }
  return progress;
}
