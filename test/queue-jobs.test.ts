import { afterEach, describe, expect, it } from 'vitest';
import { runSyncAction } from '../src/jobs/actions.js';
import { amzMassPrintLabelData, dispatchAmzMassPrintLabel, dispatchFrayunMassPrintLabel, dispatchMassPrintLabel, ozPlusLbTimes16 } from '../src/lib/queueJobs.js';
import { setQueueAddForTests } from '../src/jobs/queue.js';
import { registerScheduledJobs, scheduledActions } from '../src/jobs/scheduler.js';

describe('J1 BullMQ jobs', () => {
  afterEach(() => setQueueAddForTests(null));

  it('dispatches label jobs on the isolated BullMQ queue with legacy constructor quirks', async () => {
    const jobs: unknown[] = [];
    setQueueAddForTests(async (name, data, options) => { jobs.push({ name, data, options }); });
    await dispatchAmzMassPrintLabel({ orders: ['A'], lb: '1', oz: '2.5', length: 3, width: 4, height: 5 });
    await dispatchFrayunMassPrintLabel({ orders: ['F'], lb: 0, oz: 1, length: 3, width: 4, height: 5 });
    await dispatchMassPrintLabel({ orders: ['S'], lb: 0, oz: 1, length: 3, width: 4, height: 5, packageType: 'Package', declareValue: 0, insurance: 0 });
    expect(jobs).toEqual([
      { name: 'AmzMassPrintLabel', data: { orders: ['A'], lb: '1', oz: 18.5, length: 3, width: 4, height: 5 }, options: { attempts: 1 } },
      { name: 'FrayunMassPrintLabel', data: { orders: ['F'], lb: 0, oz: 1, length: 3, width: 4, height: 5, packageType: 'FIRST CLASS' }, options: { attempts: 1 } },
      { name: 'MassPrintLabel', data: { orders: ['S'], lb: 0, oz: 1, length: 3, width: 4, height: 5, packageType: 'Package', declareValue: 0, insurance: 0 }, options: { attempts: 1 } },
    ]);
    expect(amzMassPrintLabelData({ orders: null, lb: 'bad', oz: 'bad', length: null, width: null, height: null }).oz).toBe(0);
    expect(ozPlusLbTimes16('2', 'bad')).toBe(2);
  });

  it('registers every uncommented Kernel command with its cron and application timezone', async () => {
    const registered: unknown[] = [];
    await registerScheduledJobs({
      upsertJobScheduler: async (id, options, template) => { registered.push({ id, options, template }); },
    });
    expect(registered).toHaveLength(scheduledActions.length);
    expect(registered).toContainEqual(expect.objectContaining({
      id: 'sync-email-sales-tax-report',
      options: expect.objectContaining({ pattern: '0 6 1 * *' }),
      template: { name: 'sync', data: { action: 'email-sales-tax-report' } },
    }));
    expect(scheduledActions).toHaveLength(17);
    expect(scheduledActions.map(([id]) => id)).not.toContain('houzz');
  });

  it('matches Runner.php: an unknown sync action succeeds with no output', async () => {
    await expect(runSyncAction('not-in-runner')).resolves.toBe(0);
  });
});
