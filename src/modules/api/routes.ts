// auth:api (Passport) group from routes/api.php: /api/logout, /api/user,
// /api/settings/*, /api/pda/api-key. The Vue bundle authenticates with session
// cookies, so these serve external Bearer-token clients only (see STATUS.md).

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../db.js';
import { createHash } from 'node:crypto';
import { passportApiAuth, serializeApiUser } from '../../auth.js';

export function registerApiAuthRoutes(app: FastifyInstance): void {
  app.post('/api/logout', { preHandler: [passportApiAuth] }, async (req, reply) => {
    // Passport guard logout: revoke the token that authenticated this request.
    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
    const id = token ? token.split('.')[1] : null;
    if (id) {
      try {
        const payload = JSON.parse(Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        if (typeof payload?.id === 'string') {
          await db
            .updateTable('os_oauth_access_tokens')
            .set({ revoked: 1 })
            .where('id', '=', payload.id)
            .execute();
        }
      } catch {
        // malformed payload: nothing to revoke (guard already rejected it)
      }
    }
    reply.send();
  });

  app.get('/api/user', { preHandler: [passportApiAuth] }, async (req, reply) => {
    const user = (req as { apiUser?: { id: number } }).apiUser;
    const row = await db
      .selectFrom('os_users')
      .selectAll()
      .where('id', '=', user?.id ?? -1)
      .executeTakeFirst();
    // $request->user() serialises with $hidden = [password, remember_token]
    reply.send(row ? serializeApiUser(row as Record<string, unknown>) : {});
  });

  // Parity quirk: SettingsController has no updateProfile/updatePassword methods
  // in the old app, so both routes 500 (method does not exist). Plan: NOTES.md T02.
  const missingMethod500 = async (_req: FastifyRequest, reply: import('fastify').FastifyReply): Promise<void> => {
    reply.code(500).type('text/html; charset=UTF-8').send('500 | Server Error');
  };
  app.patch('/api/settings/profile', { preHandler: [passportApiAuth] }, missingMethod500);
  app.patch('/api/settings/password', { preHandler: [passportApiAuth] }, missingMethod500);

  app.post('/api/pda/api-key', { preHandler: [passportApiAuth] }, async (req, reply) => {
    const user = (req as { apiUser?: { id: number } }).apiUser;
    if (!user) {
      reply.code(401).send({ message: 'Unauthenticated' });
      return;
    }
    // str_random(48): 48 random alphanumeric chars
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const plain = Array.from(randomBytes(48), () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    const values = {
      name: 'pda',
      token_hash: createHash('sha256').update(plain).digest('hex'),
      token_hint: plain.slice(0, 10),
    };
    const existing = await db
      .selectFrom('os_user_api_tokens')
      .select('id')
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (existing) {
      await db.updateTable('os_user_api_tokens').set(values).where('user_id', '=', user.id).execute();
    } else {
      await db.insertInto('os_user_api_tokens').values({ ...values, user_id: user.id }).execute();
    }
    reply.send({
      api_key: plain,
      message: 'Store this key securely; it is only returned once.',
    });
  });
}
