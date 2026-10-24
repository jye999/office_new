// BullMQ jobs replace the Laravel Redis queue. The office_new prefix keeps these
// jobs away from Laravel's queues:default keys while the PHP worker still runs.

import { dispatchJob, setQueueAddForTests } from '../jobs/queue.js';

interface Dims { orders: unknown; lb: unknown; oz: unknown; length: unknown; width: unknown; height: unknown }

export const isNumeric = (v: unknown): boolean => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v));

// PHP: `if (!is_numeric($oz)) $oz = 0; if (is_numeric($lb)) $oz = $oz + $lb * 16;`.
export function ozPlusLbTimes16(oz: unknown, lb: unknown): number {
  const ounces = isNumeric(oz) ? Number(oz) : 0;
  return isNumeric(lb) ? ounces + Number(lb) * 16 : ounces;
}

export function massPrintLabelData(a: Dims & { packageType: unknown; declareValue: unknown; insurance: unknown }) {
  return { ...a };
}
export function amzMassPrintLabelData(a: Dims) {
  return { ...a, oz: ozPlusLbTimes16(a.oz, a.lb) };
}
export function frayunMassPrintLabelData(a: Dims & { packageType?: unknown }) {
  return { ...a, packageType: a.packageType ?? 'FIRST CLASS' };
}

export const dispatchMassPrintLabel = (a: Parameters<typeof massPrintLabelData>[0]) =>
  dispatchJob('MassPrintLabel', massPrintLabelData(a), { attempts: 1 });
export const dispatchAmzMassPrintLabel = (a: Dims) =>
  dispatchJob('AmzMassPrintLabel', amzMassPrintLabelData(a), { attempts: 1 });
export const dispatchFrayunMassPrintLabel = (a: Dims & { packageType?: unknown }) =>
  dispatchJob('FrayunMassPrintLabel', frayunMassPrintLabelData(a), { attempts: 1 });
export const dispatchDownloadLabel = (trackingId: unknown) => dispatchJob('DownloadLabel', { trackingId });
export const dispatchQueuePing = (msg: unknown) => dispatchJob('QueuePing', { msg }, { attempts: 1 });

// Backward-compatible test export for the pre-J1 dispatch callers.
export function setQueuePushForTests(fn: ((payload: string, queue: string) => Promise<void>) | null): void {
  setQueueAddForTests(fn ? async (name, data) => fn(JSON.stringify({ name, data }), 'jobs') : null);
}
