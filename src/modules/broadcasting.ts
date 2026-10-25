// Broadcast::routes() (BroadcastServiceProvider): POST /broadcasting/auth for Pusher private/presence channels.
// Channel rules copied from the old provider: 'App.User.*' (own id only) and 'order' (any logged-in user).
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth.js';
import { allInput } from '../http.js';
import { pusher } from '../pusher.js';

export function registerBroadcastingRoutes(app: FastifyInstance): void {
  app.post('/broadcasting/auth', async (req, reply) => {
    const { user } = await currentUser(req);
    const body = allInput(req);
    const channel = String(body['channel_name'] ?? '');
    const socketId = String(body['socket_id'] ?? '');
    const name = channel.replace(/^(private-|presence-)/, '');
    const m = /^App\.User\.(.*)$/.exec(name);
    const allowed = !!user && !!socketId && (name === 'order' || (!!m && Number(m[1]) === user.id));
    if (!allowed) return reply.code(403).send('Forbidden');
    if (channel.startsWith('presence-')) {
      return pusher().authorizeChannel(socketId, channel, { user_id: String(user.id), user_info: { ...user } });
    }
    return pusher().authorizeChannel(socketId, channel);
  });
}
