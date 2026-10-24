import { Queue, type JobsOptions } from 'bullmq';
import { config } from '../config.js';

export const QUEUE_NAME = 'jobs';
export const QUEUE_PREFIX = 'office_new';

export type OfficeJobName = 'MassPrintLabel' | 'AmzMassPrintLabel' | 'FrayunMassPrintLabel' | 'DownloadLabel' | 'QueuePing' | 'sync';
export type OfficeJobData = Record<string, unknown>;

type QueueAdd = (name: OfficeJobName, data: OfficeJobData, options?: JobsOptions) => Promise<void>;

const connection = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: null,
};

let queue: Queue<OfficeJobData, void, OfficeJobName> | null = null;
export function officeQueue(): Queue<OfficeJobData, void, OfficeJobName> {
  queue ??= new Queue<OfficeJobData, void, OfficeJobName>(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });
  return queue;
}

async function addJob(name: OfficeJobName, data: OfficeJobData, options?: JobsOptions): Promise<void> {
  await officeQueue().add(name, data, options);
}

let queueAdd: QueueAdd = addJob;
// Test seam: dispatch tests do not connect to the shared Redis instance.
export function setQueueAddForTests(fn: QueueAdd | null): void {
  queueAdd = fn ?? addJob;
}

export async function dispatchJob(name: OfficeJobName, data: OfficeJobData, options?: JobsOptions): Promise<void> {
  await queueAdd(name, data, options);
}

export const queueConnection = connection;

export async function closeOfficeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
