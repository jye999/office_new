// UnshippedController::storeLabel(): copy a label URL into the `labels` disk (storage/app/public/labels/labels/<orderId>.png|pdf).
// file_get_contents() failures are warnings that Laravel turns into exceptions -> they propagate (500).

import { disk } from '../storage.js';

export async function storeLabel(orderId: string, url: string): Promise<string> {
  const img = url.indexOf('.png') > 0 ? `${orderId}.png` : `${orderId}.pdf`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`file_get_contents(${url}): failed to open stream: HTTP ${res.status}`);
  await disk('labels').put(`labels/${img}`, Buffer.from(await res.arrayBuffer()));
  return img;
}
