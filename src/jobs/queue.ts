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

// Catalog curation gets its own queue and worker: it can run for an hour, and label
// printing must not wait behind it.
export const CATALOG_QUEUE_NAME = 'catalog';
export interface CatalogJobData {
  ids: string[];
}
export interface CatalogJobStatus {
  id: string;
  state: string;
  total: number;
  done: number;
  curated: number;
  fromModel: number;
  error?: string;
}

let catalog: Queue<CatalogJobData> | null = null;
export function catalogQueue(): Queue<CatalogJobData> {
  catalog ??= new Queue<CatalogJobData>(CATALOG_QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });
  return catalog;
}

type CatalogAdd = (data: CatalogJobData) => Promise<string>;
let catalogAdd: CatalogAdd = async (data) => {
  const job = await catalogQueue().add('curate', data, { attempts: 1, removeOnComplete: { age: 86400 }, removeOnFail: { age: 86400 } });
  return String(job.id);
};
const defaultCatalogAdd = catalogAdd;
type CatalogStatus = (id?: string) => Promise<CatalogJobStatus | null>;
let catalogStatusImpl: CatalogStatus | null = null;
// Test seam: curation tests run the work inline instead of through Redis.
export function setCatalogQueueForTests(fns: { add: CatalogAdd; status: CatalogStatus } | null): void {
  catalogAdd = fns?.add ?? defaultCatalogAdd;
  catalogStatusImpl = fns?.status ?? null;
}
export const dispatchCatalogCurate = (data: CatalogJobData): Promise<string> => catalogAdd(data);

// One job by id, else the running/waiting one (so a reloaded page picks the run back up).
export async function catalogJobStatus(id?: string): Promise<CatalogJobStatus | null> {
  if (catalogStatusImpl) return catalogStatusImpl(id);
  const q = catalogQueue();
  const job = id ? await q.getJob(id) : (await q.getJobs(['active', 'waiting'], 0, 0, true))[0];
  if (!job) return null;
  const progress = (typeof job.progress === 'object' && job.progress ? job.progress : {}) as Partial<CatalogJobStatus>;
  const total = progress.total ?? job.data.ids.length;
  return {
    id: String(job.id),
    state: await job.getState(),
    total,
    done: progress.done ?? 0,
    curated: progress.curated ?? 0,
    fromModel: progress.fromModel ?? 0,
    error: job.failedReason || undefined,
  };
}
