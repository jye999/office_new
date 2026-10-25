// POST /broadcasting/auth (guest -> 403, as the old Broadcast::routes()).
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerBroadcastingRoutes } from '../src/modules/broadcasting.js';

describe('broadcasting auth', () => {
  it('is 403 for guests', async () => {
    const app = Fastify();
    app.decorateRequest('session', null as never);
    registerBroadcastingRoutes(app);
    const r = await app.inject({ method: 'POST', url: '/broadcasting/auth', payload: { channel_name: 'private-order', socket_id: '1.2' } });
    expect(r.statusCode).toBe(403);
  });
});
