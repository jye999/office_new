import { Worker } from 'bullmq';
import { db, hwc } from '../db.js';
import { processOfficeJob } from './handlers.js';
import { QUEUE_NAME, QUEUE_PREFIX, queueConnection, type OfficeJobData, type OfficeJobName } from './queue.js';

const worker = new Worker<OfficeJobData, void, OfficeJobName>(QUEUE_NAME, processOfficeJob, {
  connection: queueConnection,
  prefix: QUEUE_PREFIX,
});

worker.on('failed', (job, err) => console.error(`job ${job?.id ?? ''} failed:`, err));
worker.on('error', (err) => console.error('worker error:', err));

async function stop(code: number): Promise<never> {
  await worker.close();
  await db.destroy();
  await hwc.destroy();
  process.exit(code);
}

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
