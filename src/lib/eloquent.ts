// Eloquent Model::save() semantics for rows read with Kysely: only dirty attributes are written, and
// updated_at is stamped (to now) when something is dirty and updated_at itself was not changed.
// Laravel 5.4 Model::originalIsEquivalent().

import { db, nowDb } from '../db.js';

type Row = Record<string, unknown>;

const isNumeric = (v: unknown): boolean => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

export function originalIsEquivalent(current: unknown, original: unknown): boolean {
  if (current === original) return true;
  if (current === null || current === undefined) return false;
  return isNumeric(current) && isNumeric(original) && String(current) === String(original);
}

// UPDATE <table> SET <dirty> WHERE <pk> = row[pk]; returns the row as the model would hold it afterwards
// (assigned values verbatim, e.g. strings that were assigned to numeric columns stay strings).
export async function saveChanges(table: string, row: Row, changes: Row, pk = 'id'): Promise<Row> {
  const dirty: Row = {};
  for (const [k, v] of Object.entries(changes)) if (!originalIsEquivalent(v, row[k])) dirty[k] = v;
  const out: Row = { ...row, ...changes };
  if (Object.keys(dirty).length === 0) return out;
  if (!('updated_at' in dirty)) dirty['updated_at'] = nowDb();
  out['updated_at'] = dirty['updated_at'];
  // SAFETY: table/column names come from callers' literals; values are bound by Kysely.
  await (db as unknown as { updateTable: (t: string) => any }).updateTable(table).set(dirty).where(pk, '=', row[pk]).execute();
  return out;
}
