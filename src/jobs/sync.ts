import { db, hwc } from '../db.js';
import { artisanCall } from './artisan.js';

const [action = '', arg1] = process.argv.slice(2);
try {
  process.exitCode = await artisanCall('sync', { action, ...(arg1 === undefined ? {} : { arg1 }) });
} finally {
  await db.destroy();
  await hwc.destroy();
}
