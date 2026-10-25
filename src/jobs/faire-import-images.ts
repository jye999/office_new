import { db, hwc } from '../db.js';
import { runFaireImportCommand } from './faire-import-command.js';

try {
  await runFaireImportCommand(process.argv.slice(2), console.log, console.error);
} finally {
  await db.destroy();
  await hwc.destroy();
}
