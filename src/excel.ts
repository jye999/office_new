// Excel reading (the old app only ever uses Excel::load(...)->get(); no
// Excel::create/download anywhere). Port of maatwebsite/excel 2.1 reader
// semantics: with heading (default) the first row becomes the object keys;
// with noHeading() rows are plain arrays (Tongtool skips row 1 itself).
// Date cells: PHPExcel returns DateTime objects; Laravel JSON encodes them as
// ISO-8601. We emit toISOString() — microsecond/offset formatting may differ
// (noted in plan/NOTES.md).

import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

export type ExcelRow = Record<string, unknown> | unknown[];

export interface ReadExcelOptions {
  // maatwebsite's noHeading().
  noHeading?: boolean;
  // File extension drives the reader; '.xlsx' if omitted (both call sites upload xlsx).
  extension?: string;
}

export type ExcelCellValue = string | number | boolean | null;

function cellValue(v: ExcelJS.CellValue): ExcelCellValue {
  if (v instanceof Date) return v.toISOString();
  if (v == null) return v === null ? '' : null; // null cell = '', empty cell = null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if ('result' in v) return cellValue((v as { result: ExcelJS.CellValue }).result); // formulas
  if ('text' in v) return (v as { text: ExcelCellValue }).text; // rich text
  return (v as { error: string }).error; // CellErrorValue
}

// Densify a 1-based exceljs row.values into a 0-based array.
function rowValues(ws: ExcelJS.Worksheet, row: ExcelJS.Row): unknown[] {
  const out: unknown[] = [];
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > out.length) out.length = colNumber;
    out[colNumber - 1] = cellValue(cell.value);
  });
  return out;
}

export async function readExcel(file: Buffer | string, options: ReadExcelOptions = {}): Promise<ExcelRow[]> {
  const buffer = Buffer.isBuffer(file) ? file : readFileSync(file);
  const workbook = new ExcelJS.Workbook();
  const ext = (options.extension ?? 'xlsx').toLowerCase();
  if (ext === 'csv') {
    // PHPExcel's CSV reader returns strings; fast-csv auto-converts numbers — map back.
    await workbook.csv.read(Readable.from(buffer), { map: (v) => String(v) });
  } else {
    // SAFETY: exceljs accepts raw bytes; its d.ts only declares ArrayBuffer.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  }
  const ws = workbook.worksheets[0];
  if (!ws) return [];

  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => rows.push(rowValues(ws, row)));

  if (options.noHeading) return rows;

  // Heading mode: first row keys the remaining rows.
  const heading = rows.shift() ?? [];
  return rows.map((r) => {
    const obj: Record<string, unknown> = {};
    heading.forEach((h, i) => {
      obj[String(h ?? '')] = r[i];
    });
    return obj;
  });
}
