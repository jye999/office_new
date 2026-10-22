// Thin Pusher wrapper (replaces vinkla/pusher + App::make('pusher')).
// Env names copied from the old .env; cluster defaults to 'mt1' like
// vinkla/pusher's config (PUSHER_APP_CLUSTER).

import Pusher from 'pusher';

let client: Pusher | null = null;

export function pusher(): Pusher {
  if (!client) {
    client = new Pusher({
      appId: process.env.PUSHER_APP_ID ?? '',
      key: process.env.PUSHER_KEY ?? '',
      secret: process.env.PUSHER_SECRET ?? '',
      cluster: process.env.PUSHER_CLUSTER ?? 'mt1',
    });
  }
  return client;
}

// $pusher->trigger($channel, $event, $data).
export async function trigger(channel: string, event: string, data: Record<string, unknown>): Promise<void> {
  await pusher().trigger(channel, event, data);
}

// Test-only seam so unit tests never hit api.pusher.com.
export function setPusherClientForTests(c: Pusher | null): void {
  client = c;
}
