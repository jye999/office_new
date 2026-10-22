// T04: yajra v6 datatables protocol against the live DB (os_opolo_cost, read-only).
import { afterAll, describe, expect, it } from 'vitest';
import { datatables } from '../src/datatables.js';
import { db, hwc } from '../src/db.js';

interface DtColumn {
  data: string;
  name: string;
  searchable: string;
  orderable: string;
  search: { value: string; regex: string };
}

interface DtRequest {
  [key: string]: unknown;
  draw: number;
  start: number;
  length: number;
  search: { value: string };
  order: { column: number; dir: string }[];
  columns: DtColumn[];
}

// DataTables-style request payload (as formbody parses search[value] etc.).
function dtRequest(overrides: Partial<DtRequest> = {}): DtRequest {
  return {
    draw: 7,
    start: 0,
    length: 3,
    search: { value: '' },
    order: [{ column: 0, dir: 'asc' }],
    columns: [
      { data: 'id', name: 'id', searchable: 'true', orderable: 'true', search: { value: '', regex: 'false' } },
      { data: 'date', name: 'date', searchable: 'true', orderable: 'true', search: { value: '', regex: 'false' } },
      { data: 'description', name: 'description', searchable: 'true', orderable: 'true', search: { value: '', regex: 'false' } },
      { data: 'category', name: 'category', searchable: 'true', orderable: 'true', search: { value: '', regex: 'false' } },
      { data: 'cost', name: 'cost', searchable: 'false', orderable: 'true', search: { value: '', regex: 'false' } },
    ],
    ...overrides,
  };
}

const query = () => db.selectFrom('os_opolo_cost').selectAll();

describe('datatables (yajra v6)', () => {
  afterAll(async () => {
    await db.destroy();
    await hwc.destroy();
  });

  it('responds with yajra v6 key order and counts', async () => {
    const res = await datatables(query()).make(dtRequest());
    expect(Object.keys(res)).toEqual(['draw', 'recordsTotal', 'recordsFiltered', 'data']);
    expect(res.draw).toBe(7);
    expect(res.recordsTotal).toBe(10);
    expect(res.recordsFiltered).toBe(10);
    expect(res.data).toHaveLength(3);
    // make(true): associative rows keyed by column
    expect(Object.keys(res.data[0])).toContain('id');
  });

  it('paginates from start, length -1 returns all', async () => {
    const res = await datatables(query()).make(dtRequest({ start: 7, length: 3 }));
    expect(res.data).toHaveLength(3);
    const all = await datatables(query()).make(dtRequest({ length: -1 }));
    expect(all.data).toHaveLength(10);
    expect(all.recordsTotal).toBe(10);
  });

  it('global search is OR LIKE %v% over searchable columns only', async () => {
    const res = await datatables(query()).make(dtRequest({ search: { value: 'UPS' } }));
    // cost is searchable:false, so 'UPS' can only match via description/date/category
    expect(res.data.length).toBeGreaterThan(0);
    for (const row of res.data) {
      const haystack = `${row.description ?? ''} ${row.date ?? ''} ${row.category ?? ''}`;
      expect(haystack).toContain('UPS');
    }
    expect(res.recordsFiltered).toBeLessThan(10);
  });

  it('applies per-column search on top of global search', async () => {
    const firstRow = (await db.selectFrom('os_opolo_cost').select('description').orderBy('id').executeTakeFirst())!;
    const word = String(firstRow.description).trim().split(/\s+/)[0];
    const req = dtRequest();
    req.columns[2].search.value = word;
    const res = await datatables(query()).make(req);
    expect(res.data.length).toBeGreaterThan(0);
    for (const row of res.data) {
      expect(String(row.description)).toContain(word);
    }
  });

  it('orders only when the column is orderable', async () => {
    const desc = await datatables(query()).make(dtRequest({ order: [{ column: 0, dir: 'desc' }] }));
    const descIds = desc.data.map((r) => Number(r.id));
    expect(descIds).toEqual([...descIds].sort((a, b) => b - a));
    const req = dtRequest();
    req.columns = req.columns.map((c) => ({ ...c, orderable: 'false' }));
    const notOrderable = await datatables(query()).make(req);
    const asc = await datatables(query()).make(dtRequest());
    expect(notOrderable.data.map((r) => Number(r.id))).toEqual(asc.data.map((r) => Number(r.id)));
  });

  it('supports addColumn callbacks and editColumn templates (OpoloCost use)', async () => {
    const res = await datatables(query())
      .addColumn('action', (o) => `<button value="${o.id}">edit</button>`)
      .editColumn('id', 'ID: {{$id}}')
      .make(dtRequest({ length: 1 }));
    const row = res.data[0];
    expect(String(row['action'])).toContain('edit');
    // editColumn template must use the pre-edit row value
    expect(String(row['id'])).toBe('ID: ' + String(row['action']).match(/value="(\d+)"/)?.[1]);
  });
});
