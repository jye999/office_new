// J7: Runner `wayfair-update-inventory` (Kernel every 52 min). DRY_RUN path only: token lookup mocked, no HTTP, no writes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setWayfairTransportForTests, Wayfair } from '../src/lib/wayfair.js';

vi.mock('../src/modules/wayfair/routes.js', () => ({ getTokenFromDB: async () => new Wayfair('tok') }));

afterEach(() => {
  delete process.env.DRY_RUN;
  setWayfairTransportForTests(null);
});

describe('wayfair-update-inventory', () => {
  it('is registered and, under DRY_RUN=1, stops before any Wayfair request', async () => {
    process.env.DRY_RUN = '1';
    const sent: unknown[] = [];
    setWayfairTransportForTests(async (req) => { sent.push(req); return { status: 200, body: Buffer.from('{}') } as never; });
    const { runSyncAction } = await import('../src/jobs/actions.js');
    await expect(runSyncAction('wayfair-update-inventory')).resolves.toBe(0);
    expect(sent).toHaveLength(0);
  });
});
