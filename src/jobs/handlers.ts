import type { Job } from 'bullmq';
import { db, nowDb } from '../db.js';
import { runSyncAction } from './actions.js';
import type { OfficeJobData, OfficeJobName } from './queue.js';

function timestamp(): Date {
  // SAFETY: Kysely's generated Date timestamp type accepts Laravel's DB-format string at runtime.
  return nowDb() as unknown as Date;
}

async function createQueueJob(type: 'label' | 'ping', status: string): Promise<number> {
  // The PHP jobs use time() rather than the queue's job id, including its
  // same-second collision behaviour.
  const queueId = Math.floor(Date.now() / 1000);
  const now = timestamp();
  await db.insertInto('os_queuejobs').values({ queueId, type, status, created_at: now, updated_at: now }).execute();
  return queueId;
}

async function labelStub(name: OfficeJobName, data: OfficeJobData): Promise<void> {
  const queueId = await createQueueJob('label', 'start');
  // The queue page joins these rows by queueId. Preserve them even though J1
  // deliberately does not transition the requested orders to `printing`.
  const orders = Array.isArray(data.orders) ? data.orders : [];
  for (const orderId of orders) {
    await db.insertInto('os_queuejob_order').values({ jobId: queueId, orderId: String(orderId), created_at: timestamp(), updated_at: timestamp() }).execute();
  }
  // J1 owns queue plumbing, not the carrier purchases inside the legacy jobs.
  // Never call them here: this worker may run against the production database.
  await db.updateTable('os_queuejobs').set({ status: 'dry-run', updated_at: timestamp() }).where('queueId', '=', queueId).execute();
  console.info(`[DRY_RUN] ${name} ${queueId}: carrier purchase stubbed`);
}

async function queuePing(): Promise<void> {
  // QueuePingEvent has no listeners, so the row is its only observable effect.
  await createQueueJob('ping', 'start');
}

async function downloadLabel(data: OfficeJobData): Promise<void> {
  // DownloadLabel fetches a carrier URL and writes the resulting label. Keep it
  // a no-op until a later carrier action explicitly enables a safe transport.
  console.info(`[DRY_RUN] DownloadLabel ${String(data.trackingId ?? '')}: download stubbed`);
}

export async function processOfficeJob(job: Job<OfficeJobData, void, OfficeJobName>): Promise<void> {
  switch (job.name) {
    case 'MassPrintLabel':
    case 'AmzMassPrintLabel':
    case 'FrayunMassPrintLabel':
      return labelStub(job.name, job.data);
    case 'DownloadLabel':
      return downloadLabel(job.data);
    case 'QueuePing':
      return queuePing();
    case 'sync':
      await runSyncAction(String(job.data.action ?? ''), typeof job.data.arg1 === 'string' ? job.data.arg1 : undefined);
      return;
  }
}
