// UnshippedController::storeLabel(): copy a label URL into the `labels` disk (storage/app/public/labels/labels/<orderId>.png|pdf).
// file_get_contents() failures are warnings that Laravel turns into exceptions -> they propagate (500).

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { disk } from '../storage.js';
import { AmazonApi } from './amazonApi.js';

export async function storeLabel(orderId: string, url: string): Promise<string> {
  const img = url.indexOf('.png') > 0 ? `${orderId}.png` : `${orderId}.pdf`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`file_get_contents(${url}): failed to open stream: HTTP ${res.status}`);
  await disk('labels').put(`labels/${img}`, Buffer.from(await res.arrayBuffer()));
  return img;
}

// Amazon MFN label: base64 gzip (or plain) PNG -> labels/<orderId>.png. PHP deletes `<orderId>.gz` (no labels/ prefix),
// which does not exist, so labels/<orderId>.gz stays. Kept.
export async function storeAmazonLabel(orderId: string, base64Contents: string): Promise<void> {
  const labels = disk('labels');
  const prefix = labels.pathPrefix().replace(/\/?$/, '/'); // Flysystem getPathPrefix() ends with a slash
  mkdirSync(`${prefix}labels`, { recursive: true });
  writeFileSync(`${prefix}labels/${orderId}.gz`, Buffer.from(base64Contents, 'base64'));
  chmodSync(`${prefix}labels/${orderId}.gz`, 0o666);
  new AmazonApi().uncompress(`${prefix}labels/${orderId}.gz`, `${prefix}labels/${orderId}.png`);
  await labels.delete(`${orderId}.gz`);
}
