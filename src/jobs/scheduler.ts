import { config } from '../config.js';
import { officeQueue } from './queue.js';

// Exactly the uncommented `$schedule->command(...)` lines of the old Kernel.php (houzz/windy/mermaid are commented out there).
export const scheduledActions = [
  ['amazon', '30 * * * *'],
  ['get-walmart-items', '10 */2 * * *'],
  ['update-walmart-inventory', '5 */2 * * *'],
  ['upload-ebay-tracking', '21 * * * *'],
  ['upload-ray-ebay-tracking', '24 * * * *'],
  ['upload-walmart-tracking', '30 * * * *'],
  ['update-amz-shipped', '32 * * * *'],
  ['update-ebay-handling', '35 * * * *'],
  ['shopify', '0 */3 * * *'],
  ['upload-shopify', '*/38 * * * *'],
  ['request-amazon-orders-report', '50 */3 * * *'],
  ['get-amazon-orders-report', '55 */3 * * *'],
  ['shopify-products', '45 4 * * *'],
  ['email-sales-report', '15 3 * * *'],
  ['email-sales-tax-report', '0 6 1 * *'],
  ['wayfair-update-inventory', '*/52 * * * *'],
  ['stats', '0 * * * *'],
] as const;

type SchedulerQueue = { upsertJobScheduler(id: string, options: { pattern: string; tz: string }, template: { name: 'sync'; data: { action: string } }): Promise<unknown> };

export async function registerScheduledJobs(q: SchedulerQueue = officeQueue()): Promise<void> {
  for (const [id, pattern] of scheduledActions) {
    const action = id.startsWith('windy-') ? 'windy' : id.startsWith('mermaid-') ? 'mermaid' : id;
    await q.upsertJobScheduler(`sync-${id}`, { pattern, tz: config.APP_TIMEZONE }, { name: 'sync', data: { action } });
  }
}

export async function registerSchedulerWhenEnabled(): Promise<void> {
  if (config.SCHEDULER_ENABLED === '1') await registerScheduledJobs();
}
