// EbayController (routes/web.php:17-19, no middleware).
// closureNotification is eBay's account-closure endpoint: the verification
// challenge returns a sha256 hex digest (string -> text/html), otherwise the
// raw body is stored in os_ebay_notification and "OK" is returned.
// ebayAccept only constructs the (lazy) raystore EbayApi client and returns "OK"
// (the old code's getTokenFromCode call is commented out) — no network traffic.

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { route } from '../../router.js';
import { EbayApi } from '../../lib/ebayApi.js';

// Laravel: returning a plain string -> text/html; charset=UTF-8.
function text(reply: { type: (t: string) => { send: (b: string) => void } }, body: string) {
  reply.type('text/html; charset=UTF-8').send(body);
}

export function registerEbayRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'any',
    path: '/ebayClosureNotification',
    name: 'ebayClosureNotification',
    handler: async (req: FastifyRequest, reply) => {
      if (input(req, 'challenge_code') != null) {
        const verificationToken = 'this_is_a_verification_token_with_a_lot_of_flowers_here';
        const endpoint = 'https://office.angelisabella.com/ebayClosureNotification';
        // PHP quirk: hash_update($hash, $request->has('challenge_code')) appends the
        // boolean's string form "1" (not the code value) — the digest is a constant.
        const responseHash = createHash('sha256').update('1' + verificationToken + endpoint).digest('hex');
        return text(reply, responseHash);
      }
      // $request->getContent(): the raw request body (formparser untouched) —
      // captured by the urlencoded content-type parser override in src/server.ts.
      const message = (req as { rawBody?: string }).rawBody ?? '';
      // SAFETY: nowDb() dateStrings written verbatim (T00); codegen types timestamp columns as Date.
      await db
        .insertInto('os_ebay_notification')
        .values({ message, created_at: nowDb() as unknown as Date, updated_at: nowDb() as unknown as Date })
        .execute();
      return text(reply, 'OK');
    },
  });

  route(app, {
    verb: 'post',
    path: '/ebayAccept',
    name: 'ebayAccept',
    handler: async (req, reply) => {
      new EbayApi('raystore');
      return text(reply, 'OK');
    },
  });

  route(app, {
    verb: 'post',
    path: '/ebayReject',
    name: 'ebayReject',
    handler: async (req, reply) => text(reply, 'OK'),
  });
}
