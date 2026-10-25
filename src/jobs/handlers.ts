import type { Job } from 'bullmq';
import { db } from '../db.js';
import { runSyncAction } from './actions.js';
import { createQueueJob, downloadLabel, runLabelJob, timestamp } from './labels.js';
import type { OfficeJobData, OfficeJobName } from './queue.js';

// DRY_RUN=1 (cutover rehearsal): the label jobs record their queue rows but never call a carrier or write a label.
async function dryRunLabelJob(name: OfficeJobName, data: OfficeJobData): Promise<void> {
  const { id, queueId } = await createQueueJob('label', 'start');
  // The queue page joins these rows by queueId.
  const orders = Array.isArray(data.orders) ? data.orders : [];
  for (const orderId of orders) {
    await db.insertInto('os_queuejob_order').values({ jobId: queueId, orderId: String(orderId), created_at: timestamp(), updated_at: timestamp() }).execute();
  }
  await db.updateTable('os_queuejobs').set({ status: 'dry-run', updated_at: timestamp() }).where('id', '=', id).execute();
  console.info(`[DRY_RUN] ${name} ${queueId}: carrier purchase skipped`);
}

async function queuePing(): Promise<void> {
  // QueuePingEvent has no listeners, so the row is its only observable effect.
  await createQueueJob('ping', 'start');
}

export async function processOfficeJob(job: Job<OfficeJobData, void, OfficeJobName>): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1';
  switch (job.name) {
    case 'MassPrintLabel':
    case 'AmzMassPrintLabel':
    case 'FrayunMassPrintLabel':
      return dryRun ? dryRunLabelJob(job.name, job.data) : runLabelJob(job.name, job.data);
    case 'DownloadLabel':
      if (dryRun) {
        console.info(`[DRY_RUN] DownloadLabel ${String(job.data.trackingId ?? '')}: download skipped`);
        return;
      }
      return downloadLabel(job.data);
    case 'QueuePing':
      return queuePing();
    case 'sync':
      await runSyncAction(String(job.data.action ?? ''), typeof job.data.arg1 === 'string' ? job.data.arg1 : undefined);
      return;
  }
}
