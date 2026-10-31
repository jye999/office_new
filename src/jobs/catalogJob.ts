import type { Job } from 'bullmq';
import { runCuration } from '../lib/catalogCurateRun.js';
import type { CatalogJobData } from './queue.js';

export async function processCatalogJob(job: Job<CatalogJobData>): Promise<void> {
  await runCuration(job.data.ids, (p) => job.updateProgress(p));
}
