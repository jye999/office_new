// T04: DatatablesEditor::process port (fake validator + fake model, no DB).
import { describe, expect, it } from 'vitest';
import {
  datatablesEditorProcess,
  type EditorInstance,
  type EditorModelSource,
  type EditorValidator,
} from '../src/lib/datatables-editor.js';

function validator(fail: false): EditorValidator {
  return { fails: () => false, errors: () => ({}) };
}

function failingValidator(errors: Record<string, string[]>): EditorValidator {
  return { fails: () => true, errors: () => errors };
}

function fakeModel(rows: Record<string, unknown>[]): EditorModelSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    all: async () =>
      rows.map(
        (row): EditorInstance => ({
          create: async (data) => {
            calls.push(`create:${JSON.stringify(data)}`);
          },
          update: async (data) => {
            calls.push(`update:${row.id}:${JSON.stringify(data)}`);
          },
          delete: async () => {
            calls.push(`delete:${row.id}`);
          },
        }),
      ),
    find: async (id) => {
      // PHP: $model->find('1') matches int PKs; compare as strings.
      if (!rows.some((r) => String(r.id) === String(id))) return null;
      return {
        update: async (data) => {
          calls.push(`update:${id}:${JSON.stringify(data)}`);
        },
        delete: async () => {
          calls.push(`delete:${id}`);
        },
      };
    },
  };
}

describe('datatablesEditorProcess', () => {
  it('returns fieldErrors on validation failure', async () => {
    const res = await datatablesEditorProcess(
      { action: 'edit', data: { '1': { sku: '', name: '' } } },
      failingValidator({ sku: ['Please provide sku name.'], name: ['Please provide name.'] }),
      fakeModel([]),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fieldErrors: [
        { name: 'sku', status: ['Please provide sku name.'] },
        { name: 'name', status: ['Please provide name.'] },
      ],
    });
  });

  it('edit updates each row and echoes data with DT_RowId', async () => {
    const model = fakeModel([{ id: 1, qty: 0 }, { id: 2, qty: 0 }]);
    const res = await datatablesEditorProcess(
      { action: 'edit', data: { 1: { qty: 5 }, 2: { qty: 7 } } },
      validator(false),
      model,
    );
    expect(model.calls).toEqual(['update:1:{"qty":5}', 'update:2:{"qty":7}']);
    expect(res.body).toEqual({
      data: [
        { DT_RowId: 'row_1', qty: 5 },
        { DT_RowId: 'row_2', qty: 7 },
      ],
    });
  });

  it('remove deletes each row', async () => {
    const model = fakeModel([{ id: 1 }, { id: 2 }]);
    const res = await datatablesEditorProcess(
      { action: 'remove', data: { 1: {}, 2: {} } },
      validator(false),
      model,
    );
    expect(model.calls).toEqual(['delete:1', 'delete:2']);
    expect(res.body.data).toHaveLength(2);
  });

  it('create via Builder path throws (PHP null->create fatal, kept quirk)', async () => {
    await expect(
      datatablesEditorProcess({ action: 'create', data: { 0: { sku: 'x' } } }, validator(false), fakeModel([{ id: 1 }])),
    ).rejects.toThrow('create() on null');
  });

  it('edit on a missing row throws (PHP null->update fatal, kept quirk)', async () => {
    await expect(
      datatablesEditorProcess({ action: 'edit', data: { 99: { qty: 1 } } }, validator(false), fakeModel([{ id: 1 }])),
    ).rejects.toThrow('update() on null');
  });
});
