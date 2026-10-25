// Runner.php `wayfair-update-inventory` (UpdateWayfairInventory), scheduled every 52 minutes in Kernel.php:
// push every os_wayfair_inventory row as a DIFFERENTIAL inventory update. Under DRY_RUN=1 the Wayfair
// client stops the mutation before any HTTP (WayfairDryRunError); the token lookup still only reads.
import { db } from '../../db.js';
import { WayfairDryRunError } from '../../lib/wayfair.js';
import { getTokenFromDB } from '../../modules/wayfair/routes.js';

export const wayfairActions = {
  'wayfair-update-inventory': async (): Promise<number> => {
    const items = await db.selectFrom('os_wayfair_inventory').selectAll().execute();
    const wayfair = await getTokenFromDB();
    try {
      // PHP print_r($resp)
      console.log(await wayfair.updateInventory(items as never));
    } catch (e) {
      if (e instanceof WayfairDryRunError) {
        console.info('[DRY_RUN] wayfair-update-inventory skipped');
        return 0;
      }
      throw e;
    }
    return 0;
  },
};
