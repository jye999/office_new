// T04: pusher + mail helpers (no network).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pusher, setPusherClientForTests, trigger } from '../src/pusher.js';
import { sendMail } from '../src/mail.js';

describe('pusher', () => {
  afterEach(() => setPusherClientForTests(null));

  it('trigger delegates to the pusher client (angel-channel/message-event shape)', async () => {
    const calls: [string, string, Record<string, unknown>][] = [];
    setPusherClientForTests({ trigger: async (c: string, e: string, d: Record<string, unknown>) => void calls.push([c, e, d]) } as never);
    await trigger('angel-channel', 'message-event', { new_message: true, from_user: 1 });
    expect(calls).toEqual([['angel-channel', 'message-event', { new_message: true, from_user: 1 }]]);
  });

  it('pusher() builds a client from PUSHER_* env with mt1 default cluster', () => {
    vi.stubEnv('PUSHER_APP_ID', '123');
    vi.stubEnv('PUSHER_KEY', 'key');
    vi.stubEnv('PUSHER_SECRET', 'secret');
    const client = pusher() as unknown as { config: { appId: string; host: string } };
    expect(client.config.appId).toBe('123');
    expect(client.config.host).toBe('api-mt1.pusher.com');
    setPusherClientForTests(null);
  });
});

describe('mail', () => {
  it('no-ops and logs unless MAIL_ENABLED=1', async () => {
    vi.stubEnv('MAIL_ENABLED', '0');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendMail({ from: 'admin@angelisabella.com', to: 'a@b.c', subject: 'Tracking Upload Error!', html: '<p>hi</p>' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[mail disabled]'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Tracking Upload Error!'));
    log.mockRestore();
  });

  it('is a no-op when MAIL_ENABLED is unset', async () => {
    vi.stubEnv('MAIL_ENABLED', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(sendMail({ from: 'a@b.c', to: 'a@b.c', subject: 's', html: 'h' })).resolves.toBeUndefined();
    log.mockRestore();
  });
});
