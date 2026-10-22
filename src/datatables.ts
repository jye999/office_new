// yajra/laravel-datatables-oracle v6 server-side protocol over Kysely queries.
// Ported from vendor/yajra/laravel-datatables-oracle (BaseEngine, QueryBuilderEngine,
// Request, DataProcessor). Matches v6 defaults: smart search on, no wildcards,
// case-sensitive, blacklist [password, remember_token], whitelist '*'.
// `make(true)` semantics: rows are associative objects keyed by column name.
// Not ported (unused by the app): filterColumn/orderColumn, regex search, row
// templates (DT_Row*), escapeColumns, transformer, appends.

import { sql } from './db.js';

// Structural Kysely select query (same pattern as Paginatable in http.ts).
// Kysely builders are immutable — every method returns a new builder.
export interface DataTablesSource {
  where(cond: unknown): DataTablesSource;
  orderBy(column: string, direction?: 'asc' | 'desc'): DataTablesSource;
  offset(n: number): DataTablesSource;
  limit(n: number): DataTablesSource;
  select(selectors: unknown[]): DataTablesSource;
  execute(): Promise<Record<string, unknown>[]>;
  getTable?(): string | undefined;
  getColumns?(): string[];
}

// Values that end up in a response cell (Kysely rows are strings/numbers/null; callbacks may add objects).
export type CellValue = string | number | boolean | null | object;

export type ColumnContent =
  | string // Blade-like template: 'ID: {{$id}}'
  | ((row: Record<string, unknown>) => CellValue);

export interface DatatablesResponse {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: Record<string, unknown>[];
}

type DtInputValue = string | number | boolean | null | Record<string, unknown>;

const BLACKLIST = ['password', 'remember_token'];

// Laravel dot-notation input() over the merged query+body object.
function get(input: Record<string, unknown>, path: string): DtInputValue {
  const value = path
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | null)?.[part], input);
  if (value == null || typeof value === 'object') return value as DtInputValue;
  return value as string | number | boolean;
}

function columnNameByIndex(input: Record<string, unknown>, index: number): DtInputValue {
  const column = get(input, `columns.${index}`) as Record<string, unknown> | null;
  return (column?.['name'] ?? column?.['data'] ?? null) as DtInputValue;
}

// v6 BaseEngine::setupKeyword (smart search on, use_wildcards off).
function setupKeyword(value: DtInputValue): string {
  const keyword = '%' + String(value ?? '') + '%';
  return keyword.replace(/\\/g, '%'); // remove escaping slash added on js script request
}

export class DataTablesBuilder {
  private columns: { name: string; content: ColumnContent; order: false | number }[] = [];
  private edits: { name: string; content: ColumnContent }[] = [];

  constructor(private query: DataTablesSource) {}

  // v6 BaseEngine::addColumn.
  addColumn(name: string, content: ColumnContent, order: false | number = false): this {
    this.columns.push({ name, content, order });
    return this;
  }

  // v6 BaseEngine::editColumn.
  editColumn(name: string, content: ColumnContent): this {
    this.edits.push({ name, content });
    return this;
  }

  // v6 BaseEngine::make (mDataSupport true — all call sites use make(true)).
  async make(input: Record<string, unknown>): Promise<DatatablesResponse> {
    const totalRecords = await this.count(this.query);
    let q = this.query;
    let filteredRecords = 0;
    if (totalRecords) {
      q = this.ordering(q, input);
      const { query: filtered, isFilterApplied } = this.filterRecords(q, input);
      q = filtered;
      // v6: filteredRecords is a query count when any filter was applied.
      filteredRecords = isFilterApplied ? await this.count(q) : totalRecords;
      if (this.isPaginationable(input)) {
        const start = Number(get(input, 'start'));
        const length = Number(get(input, 'length'));
        q = q.offset(start).limit(length > 0 ? length : 10);
      }
    }
    const rows = await q.execute();
    return {
      draw: Number(get(input, 'draw')),
      recordsTotal: totalRecords,
      recordsFiltered: filteredRecords,
      data: rows.map((row) => this.processRow(row)),
    };
  }

  // v6 QueryBuilderEngine::count — plain select-count (all call sites are simple queries).
  private async count(q: DataTablesSource): Promise<number> {
    // v6 selects `'1' as row_count` and counts the returned rows; Kysely has no
    // select-replacement, so counting fetched rows is the same result.
    const rows = await q.execute();
    return rows.length;
  }

  // v6 BaseEngine::getColumnName (wantsAlias: true for ordering).
  private getColumnName(input: Record<string, unknown>, index: number, wantsAlias: boolean): string {
    let column = String(columnNameByIndex(input, index) ?? '');
    if (column.trim() !== '' && !isNaN(Number(column))) {
      const cols = this.query.getColumns?.() ?? [];
      column = cols[index] && cols[index] !== '*' ? cols[index] : 'id';
      if (this.columns.some((c) => c.name === column)) column = 'id'; // v6: extra columns fall back to pk
    }
    if (column.toUpperCase().includes(' AS ')) {
      const matches = column.toLowerCase().split(' as ');
      column = wantsAlias ? matches[matches.length - 1] : matches[0];
    }
    // v6 quirk: extractColumnName also strips `table.` to the bare column
    // (unqualified even for search), applied in both branches.
    if (column.includes('.')) column = column.split('.').pop() as string;
    return column;
  }

  private isBlacklisted(column: string): boolean {
    return BLACKLIST.includes(column); // whitelist '*'
  }

  // v6 QueryBuilderEngine::ordering.
  private ordering(q: DataTablesSource, input: Record<string, unknown>): DataTablesSource {
    const order = (get(input, 'order') as { column: number; dir: string }[] | null) ?? [];
    if (!order.length) return q;
    for (const o of order) {
      const idx = Number(o.column);
      if (String(get(input, `columns.${idx}.orderable`)) !== 'true') continue;
      const column = this.getColumnName(input, idx, true);
      if (this.isBlacklisted(column)) continue;
      q = q.orderBy(column, o.dir === 'desc' ? 'desc' : 'asc');
    }
    return q;
  }

  // v6 BaseEngine::filterRecords.
  private filterRecords(q: DataTablesSource, input: Record<string, unknown>): { query: DataTablesSource; isFilterApplied: boolean } {
    let isFilterApplied = false;
    // v6 Request::isSearchable: input('search.value') != '' (null counts as searchable).
    const keyword = get(input, 'search.value');
    if (keyword !== '') {
      const cols = this.searchableColumns(input);
      if (cols.length) {
        const kw = setupKeyword(keyword);
        // Nested OR group, like v6's where(fn) with orWhereRaw per column.
        q = q.where(
          sql`${sql.join(cols.map((c) => sql`${sql.ref(this.qualified(c))} LIKE ${kw}`), sql` or `)}`,
        );
        isFilterApplied = true;
      }
    }
    // v6 QueryBuilderEngine::columnSearch (regex search unused by the app).
    const n = (get(input, 'columns') as unknown[] | null)?.length ?? 0;
    for (let i = 0; i < n; i++) {
      if (String(get(input, `columns.${i}.searchable`)) !== 'true') continue;
      const raw = get(input, `columns.${i}.search.value`);
      if (raw === '') continue;
      const column = this.getColumnName(input, i, false);
      if (this.isBlacklisted(column)) continue;
      q = q.where(sql`${sql.ref(this.qualified(column))} LIKE ${setupKeyword(raw)}`);
      isFilterApplied = true;
    }
    return { query: q, isFilterApplied };
  }

  // v6 Request::searchableColumnIndex + isBlacklisted.
  private searchableColumns(input: Record<string, unknown>): string[] {
    const n = (get(input, 'columns') as unknown[] | null)?.length ?? 0;
    const cols: string[] = [];
    for (let i = 0; i < n; i++) {
      if (String(get(input, `columns.${i}.searchable`)) !== 'true') continue;
      const column = this.getColumnName(input, i, false);
      if (this.isBlacklisted(column)) continue;
      cols.push(column);
    }
    return cols;
  }

  // v6 QueryBuilderEngine::addTablePrefix (search only).
  private qualified(column: string): string {
    if (!column.includes('.')) {
      const table = this.query.getTable?.();
      if (table) return `${table}.${column}`;
    }
    return column;
  }

  // v6 Request::isPaginationable (length -1 = all records).
  private isPaginationable(input: Record<string, unknown>): boolean {
    return get(input, 'start') != null && get(input, 'length') != null && Number(get(input, 'length')) !== -1;
  }

  // v6 DataProcessor::process (object mode) + Helper::compileContent.
  private processRow(row: Record<string, unknown>): Record<string, unknown> {
    const data: Record<string, unknown> = { ...row };
    for (const { name, content, order } of this.columns) {
      data[name] = this.compileContent(content, data, row);
      // v6 Helper::includeInArray: insert at `order`, append when invalid.
      if (typeof order === 'number' && order < Object.keys(data).length - 1) {
        const value = data[name];
        const keys = Object.keys(data).filter((k) => k !== name);
        const first: Record<string, unknown> = {};
        keys.slice(0, order).forEach((k) => (first[k] = data[k]));
        const rest: Record<string, unknown> = {};
        keys.slice(order).forEach((k) => (rest[k] = data[k]));
        Object.assign(data, first, { [name]: value }, rest);
      }
    }
    for (const { name, content } of this.edits) {
      data[name] = this.compileContent(content, data, row);
    }
    return data;
  }

  private compileContent(content: ColumnContent, data: Record<string, unknown>, row: Record<string, unknown>): CellValue {
    if (typeof content === 'string') {
      // v6 Blade compilation of '{{$field}}' — only simple variable echo is used by the app.
      return content.replace(/\{\{\s*\$?(\w+)\s*\}\}/g, (_, key: string) => String(data[key] ?? row[key] ?? ''));
    }
    return content(row);
  }
}

export function datatables(query: DataTablesSource): DataTablesBuilder {
  return new DataTablesBuilder(query);
}
