import { Worker } from 'bullmq';
import { db, hwc } from '../db.js';
import { processOfficeJob } from './handlers.js';
import { processCatalogJob } from './catalogJob.js';
import { CATALOG_QUEUE_NAME, QUEUE_NAME, QUEUE_PREFIX, queueConnection, type OfficeJobData, type OfficeJobName } from './queue.js';

const worker = new Worker<OfficeJobData, void, OfficeJobName>(QUEUE_NAME, processOfficeJob, {
  connection: queueConnection,
  prefix: QUEUE_PREFIX,
});

const catalogWorker = new Worker(CATALOG_QUEUE_NAME, processCatalogJob, { connection: queueConnection, prefix: QUEUE_PREFIX });
catalogWorker.on('failed', (job, err) => console.error(`catalog job ${job?.id ?? ''} failed:`, err));
catalogWorker.on('error', (err) => console.error('catalog worker error:', err));

worker.on('failed', (job, err) => console.error(`job ${job?.id ?? ''} failed:`, err));
worker.on('error', (err) => console.error('worker error:', err));

async function stop(code: number): Promise<never> {
  await worker.close();
  await catalogWorker.close();
  await db.destroy();
  await hwc.destroy();
  process.exit(code);
}

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
