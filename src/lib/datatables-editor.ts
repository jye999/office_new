// Port of app/Libraries/DatatablesEditor.php (DataTables Editor protocol:
// create / edit / remove for one or more rows).
// Quirks kept from the original (see plan/NOTES.md):
// - The Builder path normalizes to `all()[0]`; `create` on that path crashes in
//   PHP too (null->create), so it throws here as well.
// - `find()` missing a row crashes the update/delete in PHP; we 500 likewise.
// - The success response merges DT_RowId UNDER the row data only for new keys
//   (PHP `+` keeps the left side on key collision — DT_RowId wins).

import { db, nowDb, sql } from '../db.js';

export interface EditorRecord {
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

export interface EditorInstance extends EditorRecord {
  create(data: Record<string, unknown>): Promise<void>;
}

// Eloquent Builder analog: all() mirrors ->get(), find() mirrors Model::find().
export interface EditorModelSource {
  all(): Promise<EditorInstance[]>;
  find(id: string | number): Promise<EditorRecord | null>;
}

// Laravel Validator analog (the module builds it with zod).
export interface EditorValidator {
  fails(): boolean;
  // errors keyed by field, messages as arrays — Validator::errors() shape.
  errors(): Record<string, string[]>;
}

// Plain-table adapter used by the string (table name) path.
function tableSource(table: string): EditorModelSource {
  return {
    all: async () => {
      const rows = (await db.selectFrom(table as never).selectAll().execute()) as Record<string, unknown>[];
      return rows.map((row) => makeInstance(table, row.id as string | number));
    },
    find: async (id) => {
      const row = (await db
        .selectFrom(table as never)
        .selectAll()
        .where(sql<boolean>`(id) = ${id}`)
        .executeTakeFirst()) as Record<string, unknown> | undefined;
      return row ? makeInstance(table, id) : null;
    },
  };
}

function makeInstance(table: string, id: string | number): EditorInstance {
  return {
    // Model::create: mass-assign + timestamps (Inventory has the default $timestamps).
    async create(data) {
      const now = nowDb();
      await db.insertInto(table as never).values({ ...data, created_at: now, updated_at: now } as never).execute();
    },
    async update(data) {
      await db
        .updateTable(table as never)
        .set({ ...data, updated_at: nowDb() } as never)
        .where(sql<boolean>`(id) = ${id}`)
        .execute();
    },
    async delete() {
      await db.deleteFrom(table as never).where(sql<boolean>`(id) = ${id}`).execute();
    },
  };
}

export interface EditorResult {
  status: number;
  body: Record<string, unknown>;
}

// DatatablesEditor::process. `input` is $req->input() (body), `source` the
// Eloquent Builder (or table name for the string path).
export interface EditorInput {
  action: 'create' | 'edit' | 'remove';
  data: Record<string, Record<string, unknown>>;
}

export async function datatablesEditorProcess(
  input: EditorInput,
  validator: EditorValidator,
  source: string | EditorModelSource,
): Promise<EditorResult> {
  const rowFirstId = Object.keys(input.data)[0];
  const rowIdArray = Object.keys(input.data);

  if (validator.fails()) {
    const messages = validator.errors();
    const fieldErrors = Object.keys(messages).map((name) => ({ name, status: messages[name] }));
    return { status: 200, body: { fieldErrors } };
  }

  const isString = typeof source === 'string';
  const modelSource = isString ? tableSource(source) : source;
  const action = input.action;
  if (action === 'create') {
    if (isString) {
      const instance = (await modelSource.all())[0];
      if (!instance) throw new Error('System Error: no rows');
      await instance.create(input.data[rowFirstId]);
    } else {
      // PHP: $model[0] on a Model instance is null → fatal. Replicate as 500.
      throw new Error('Call to a member function create() on null');
    }
  }
  if (action === 'edit') {
    for (const rowId of rowIdArray) {
      const record = await modelSource.find(rowId);
      if (!record) throw new Error('Call to a member function update() on null');
      await record.update(input.data[rowId]);
    }
  }
  if (action === 'remove') {
    for (const rowId of rowIdArray) {
      const record = await modelSource.find(rowId);
      if (!record) throw new Error('Call to a member function delete() on null');
      await record.delete();
    }
  }

  const data = rowIdArray.map((rowId) => ({ DT_RowId: 'row_' + rowId, ...input.data[rowId] }));
  return { status: 200, body: { data } };
}
