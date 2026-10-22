import { describe, expect, it } from 'vitest';
import { nowDb } from '../src/db.js';

describe('nowDb', () => {
  it('formats as YYYY-MM-DD HH:mm:ss in APP_TIMEZONE', () => {
    const d = new Date('2025-01-02T15:04:05Z'); // 10:04:05 in America/New_York (EST)
    expect(nowDb(d)).toBe('2025-01-02 10:04:05');
  });

  it('matches the format regex', () => {
    expect(nowDb()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
