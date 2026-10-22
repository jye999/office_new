// T04: excel reader (maatwebsite 2.1 semantics) + sharp image helpers.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { readExcel } from '../src/excel.js';
import { image } from '../src/images.js';

async function makeXlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('sheet');
  rows.forEach((r, i) => ws.getRow(i + 1).values = r as ExcelJS.CellValue[]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('readExcel', () => {
  it('heading mode: first row becomes keys (Wayfair picklist use)', async () => {
    const buf = await makeXlsx([
      ['item_number', 'qty'],
      ['SKU-1', 2],
      ['SKU-2', 3],
    ]);
    const rows = (await readExcel(buf)) as Record<string, unknown>[];
    expect(rows).toEqual([
      { item_number: 'SKU-1', qty: 2 },
      { item_number: 'SKU-2', qty: 3 },
    ]);
  });

  it('noHeading mode: plain arrays including row 1 (Tongtool picklist use)', async () => {
    const buf = await makeXlsx([
      ['col_a', 'col_b'],
      ['x', 'y'],
    ]);
    const rows = (await readExcel(buf, { noHeading: true })) as unknown[][];
    expect(rows).toEqual([
      ['col_a', 'col_b'],
      ['x', 'y'],
    ]);
  });

  it('csv input works', async () => {
    const rows = (await readExcel(Buffer.from('a,b\n1,2\n'), { extension: 'csv' })) as Record<string, unknown>[];
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('image (Intervention widen/resize upsize)', () => {
  const png200x100 = async () => sharpSource(200, 100);
  async function sharpSource(w: number, h: number): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  }

  it('widen(100) scales down keeping aspect', async () => {
    const sharp = (await import('sharp')).default;
    const out = await image(await png200x100()).widen(100).stream();
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(50);
    expect(meta.format).toBe('png'); // output keeps input format, like Intervention
  });

  it('widen + upsize never enlarges', async () => {
    const sharp = (await import('sharp')).default;
    const out = await image(await png200x100()).widen(500, (c) => c.upsize()).stream();
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
  });

  it('resize(300, null, upsize) on a smaller image is a no-op (ItemController use)', async () => {
    const sharp = (await import('sharp')).default;
    const out = await image(await sharpSource(200, 100)).resize(300, null, (c) => c.upsize()).stream();
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
  });
});
