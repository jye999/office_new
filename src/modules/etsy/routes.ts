// EtsyController (routes/web.php:22-23 unauthenticated; :398-401 role:admin,user,remote).
// OAuth1 (getTokenRequest/2/3, Test) runs on L06's EtsyOAuth1 with the request-token
// secret kept in the web session between calls (old app: OAuth\Common\Storage\Session).
// The legacy `app.etsy` config key (no digit) does not exist in the old config —
// getTokenRequest/Test run with null credentials (see plan/NOTES.md).
// OAuth2 (callback/sendAuthRequest) uses L06's EtsyOAuth2Provider; tokens are
// persisted in the `integration` DB's `etsy_integration` table, as the old app does.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MysqlDialect } from 'kysely';
import mysql from 'mysql2';
import { Kysely } from 'kysely';
import { config } from '../../config.js';
import { nowDb } from '../../db.js';
import { input } from '../../http.js';
import { route, routeUrl } from '../../router.js';
import { sendServer500 } from '../../view.js';
import { EtsyOAuth1, EtsyOAuth2Provider } from '../../lib/etsy.js';

const ROLES = ['admin', 'user', 'remote'];

// ---- PHP print_r (objects only: associative + indexed arrays, objects) ----------

function phpVal(v: unknown, indent: string, className?: string): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    const s = String(v);
    // PHP 7.4 var_dump-style serialization of doubles
    if (s.includes('e')) return s;
    return s;
  }
  const o = v as Record<string, unknown>;
  const entries = Object.entries(o);
  const indexed = entries.length > 0 && entries.every(([k], i) => k === String(i));
  const inner = entries.map(([k, v2]) => `${indent}    ${indexed ? '' : `[${k}] => `}${phpVal(v2, indent + '    ')}`).join('\n');
  return `${className ?? (indexed ? 'Array' : 'Object')}\n${indent}(\n${inner}\n${indent})`;
}

// print_r(): 4-space indent; a blank line separates a nested collection's closing
// paren from its parent's (PHP quirk, e.g. the empty extraParams Array).
function phpPrintR(v: unknown, className?: string): string {
  if (v === null || v === undefined) return 'NULL\n';
  if (typeof v !== 'object') return `${phpVal(v, '')}\n`;
  const o = v as Record<string, unknown>;
  const entries = Object.entries(o);
  const lines = entries.map(([k, v2]) => {
    const rendered = phpVal(v2, '    ');
    const nested = rendered.includes('\n');
    return `    [${k}] => ${rendered}${nested ? '\n' : ''}`;
  });
  const content = lines.length ? `${lines.join('\n')}\n` : '';
  return `${className ?? 'Object'}${className ? ' Object' : ''}\n(\n${content})\n`;
}

// print_r(StdOAuth1Token): protected properties, legacy property order, EOL -9001
// (Etsy::parseAccessTokenResponse sets EOL_NEVER_EXPIRES == EOL_UNKNOWN here).
function tokenPrint(t: { accessToken: string; accessTokenSecret: string; requestTokenSecret?: string; extraParams?: Record<string, string> }): string {
  const extra = Object.entries(t.extraParams ?? {})
    .map(([k, v]) => `            [${k}] => ${v}`)
    .join('\n');
  return 'OAuth\\OAuth1\\Token\\StdOAuth1Token Object\n(\n'
    + `    [requestToken:protected] => ${t.accessToken}\n`
    + `    [requestTokenSecret:protected] => ${t.requestTokenSecret ?? ''}\n`
    + `    [accessTokenSecret:protected] => ${t.accessTokenSecret}\n`
    + `    [accessToken:protected] => ${t.accessToken}\n`
    + `    [refreshToken:protected] => ${t.requestTokenSecret ?? ''}\n`
    + '    [endOfLife:protected] => -9001\n'
    + '    [extraParams:protected] => Array\n        (\n'
    + (extra ? `${extra}\n` : '')
    + '        )\n\n)\n';
}

// ---- OAuth1 session token storage (old app: OAuth\Common\Storage\Session) -------

// @fastify/secure-session stores the whole token object at one flat key.
function storeOauth1Token(req: FastifyRequest, token: {
  accessToken: string;
  accessTokenSecret: string;
  requestTokenSecret?: string;
  extraParams?: Record<string, string>;
}): void {
  (req.session as Record<string, unknown> & { set: (k: string, v: unknown) => void }).set('oauth.Etsy', token);
  (req as { saveSession?: () => Promise<void> }).saveSession?.();
}

function fetchOauth1Token(req: FastifyRequest): {
  accessToken: string;
  accessTokenSecret: string;
  requestTokenSecret?: string;
  extraParams?: Record<string, string>;
} {
  const s = (req.session as Record<string, unknown> & { get: (k: string) => unknown }).get('oauth.Etsy') as
    | { accessToken: string; accessTokenSecret: string; requestTokenSecret?: string; extraParams?: Record<string, string> }
    | null;
  // Old app: storage->retrieveAccessToken throws 'Token not found in session...' -> 500.
  if (!s) throw new Error('Token not found in session, are you sure you stored it?');
  return s;
}

// ---- integration DB (old config/database.php 'integration' connection) ----------

interface IntegrationDB {
  etsy_integration: {
    id: number | null;
    created_at: string | null;
    client_id: string | null;
    client_secret: string | null;
    access_token: string | null;
    refresh_token: string | null;
    updated_at: string | null;
    user_id: string | null;
    shop_id: string | null;
  };
}

// The pool is created per callback so DB_INTEGRATION_DATABASE can be re-pointed
// (unit tests); the pool idles after each request.
function integrationDb(): Kysely<IntegrationDB> {
  const name = process.env.DB_INTEGRATION_DATABASE || 'integration';
  // Same pool options as src/db.ts (mysql2 `timezone: 'local'`).
  const pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USERNAME,
    password: config.DB_PASSWORD,
    database: name,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    timezone: 'local' as const,
  });
  return new Kysely<IntegrationDB>({ dialect: new MysqlDialect({ pool }) });
}

// ---- OAuth1 routes (getTokenRequest/2/3 + Test) ----------------------------------

// Old app prints `$response` (the request token) after the access-token exchange,
// not `$t` — kept as-is.
async function oauth1TokenFlow(
  req: FastifyRequest,
  reply: FastifyReply,
  service: EtsyOAuth1,
): Promise<void> {
  let html = '';
  try {
    const oauthToken = input(req, 'oauth_token');
    if (oauthToken != null) {
      const stored = fetchOauth1Token(req);
      service.storeAccessToken(stored);
      const t = await service.requestAccessToken(String(oauthToken), String(input(req, 'oauth_verifier') ?? ''), stored.requestTokenSecret ?? null);
      storeOauth1Token(req, t);
      // The old app prints $response (the stored request token, before the exchange), not $t.
      html += tokenPrint(stored);
    } else {
      const token = await service.requestRequestToken();
      const extra = (token.extraParams ?? {}) as Record<string, string>;
      const url = extra['login_url'];
      html += phpPrintR({}, 'OAuth\\OAuth1\\Token\\StdOAuth1Token');
      html += '<br>';
      html += phpPrintR(extra);
      html += '<br>';
      html += `<a href='${url}' target='_blank'>${url}</a><br/>`;
      const query = (new URL(url)).search.slice(1);
      const arr: Record<string, string> = {};
      for (const pair of query.split('&')) {
        if (!pair) continue;
        const i = pair.indexOf('=');
        const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
        arr[k] = decodeURIComponent(i < 0 ? '' : pair.slice(i + 1).replace(/\+/g, ' '));
      }
      html += "<form >";
      html += `token: <input type='text' name='oauth_token' value='${arr['oauth_token']}'><br/>`;
      html += "verifier : <input type='text' name='oauth_verifier'><br/>";
      html += "<input type='submit' value='submit'>";
      html += '</form>';
      html += phpPrintR(url);
    }
  } catch {
    return sendServer500(req, reply);
  }
  return reply.type('text/html; charset=UTF-8').send(html);
}

function oauth1Service(storeKey: '1' | '2' | '3' | 'legacy'): EtsyOAuth1 {
  // config('app.etsy<storeKey>.consumerKey/consumerSecret') — the legacy key is absent.
  const key = process.env[`ETSY_CONSUMER_KEY${storeKey}`] ?? '';
  const secret = process.env[`ETSY_CONSUMER_SECRET${storeKey}`] ?? '';
  return new EtsyOAuth1(key, secret);
}

async function getTokenRequestN(req: FastifyRequest, reply: FastifyReply, storeKey: '1' | '2' | '3' | 'legacy'): Promise<void> {
  return oauth1TokenFlow(req, reply, oauth1Service(storeKey));
}

// ---- register --------------------------------------------------------------------

export function registerEtsyRoutes(app: FastifyInstance): void {
  const provider = (): EtsyOAuth2Provider =>
    new EtsyOAuth2Provider({
      clientId: process.env.ETSY_CONSUMER_KEY1 ?? '',
      clientSecret: process.env.ETSY_CONSUMER_SECRET1 ?? '',
      redirectUri: routeUrl('etsy-callback-url'),
    });

  route(app, {
    verb: 'any',
    path: '/etsy-callback-url',
    name: 'etsy-callback-url',
    handler: async (req, reply) => {
      let html = '';
      try {
        const session = req.session as Record<string, unknown> & { get: (k: string) => unknown };
        const preChallenge = session.get('oauth2code') as string | null;
        const token = await provider().getAccessToken('authorization_code', {
          code: String(input(req, 'code') ?? ''),
          code_verifier: preChallenge ?? '',
        });
        const access_token = token.accessToken;
        const refresh_token = token.refreshToken;
        const ownerId = token.resourceOwnerId;
        const user_id = access_token.split('.')[0];

        html += 'userid <br/>';
        html += phpPrintR(user_id);

        const db = integrationDb();
        let row = await db.selectFrom('etsy_integration').selectAll().where('user_id', '=', user_id).executeTakeFirst();
        if (!row) {
          const now = nowDb();
          await db
            .insertInto('etsy_integration')
            .values({
              client_id: process.env.ETSY_CONSUMER_KEY1 ?? '',
              client_secret: process.env.ETSY_CONSUMER_SECRET1 ?? '',
              access_token,
              refresh_token: refresh_token ?? '',
              updated_at: now,
              created_at: now,
              user_id,
            })
            .execute();
        } else {
          await db
            .updateTable('etsy_integration')
            .set({ access_token, refresh_token: refresh_token ?? '', updated_at: nowDb() })
            .where('user_id', '=', user_id)
            .execute();
        }
        await db.destroy();

        html += 'access_token<br/>';
        html += phpPrintR(access_token);
        html += '<br/>';
        html += 'refresh_token<br/>';
        html += phpPrintR(refresh_token);
        html += '<br/>';
        html += '<br/>';

        const user = await provider().getResourceOwner(token);
        html += 'expires<br/>';
        html += phpPrintR(token.expires);
        html += '<br/>';
        // print_r($user): EtsyResourceOwner (properties = the decoded user + the token).
        html += phpPrintR(user ?? null);
        html += phpPrintR(ownerId);
      } catch {
        return sendServer500(req, reply);
      }
      return reply.type('text/html; charset=UTF-8').send(html);
    },
  });

  route(app, {
    verb: 'any',
    path: '/etsy-auth-request',
    name: 'etsy-auth-request',
    handler: async (req, reply) => {
      const p = provider();
      const preChallenge = p.getPreChallenge();
      const authUrl = p.getAuthorizationUrl({
        code_challenge: p.getPKCE(preChallenge),
        code_challenge_method: 'S256',
        scope: ['email_r', 'listings_r', 'listings_w', 'transactions_r', 'transactions_w', 'profile_r', 'shops_r', 'shops_w'],
      });
      const session = req.session as Record<string, unknown> & { set: (k: string, v: unknown) => void };
      session.set('oauth2state', p.getState());
      session.set('oauth2code', preChallenge);
      (req as { saveSession?: () => Promise<void> }).saveSession?.();
      return reply.code(302).redirect(authUrl);
    },
  });

  route(app, {
    verb: 'get',
    path: '/EtsyTokenRequest',
    name: 'EtsyTokenRequest',
    roles: ROLES,
    handler: async (req, reply) => getTokenRequestN(req, reply, 'legacy'),
  });

  route(app, {
    verb: 'get',
    path: '/Etsy2TokenRequest',
    name: 'Etsy2TokenRequest',
    roles: ROLES,
    handler: async (req, reply) => getTokenRequestN(req, reply, '2'),
  });

  route(app, {
    verb: 'get',
    path: '/Etsy3TokenRequest',
    name: 'Etsy3TokenRequest',
    roles: ROLES,
    handler: async (req, reply) => getTokenRequestN(req, reply, '3'),
  });

  route(app, {
    verb: 'get',
    path: '/EtsyTest',
    name: 'EtsyTest',
    roles: ROLES,
    handler: async (req, reply) => {
      let html = '';
      try {
        // config('app.etsy.token'/'secret') — the legacy key is absent (null).
        const service = oauth1Service('legacy');
        const token = {
          accessToken: process.env.ETSY_TOKEN ?? '',
          accessTokenSecret: process.env.ETSY_SECRET ?? '',
        };
        service.storeAccessToken(token);
        html += tokenPrint(token);
        html += '<hr/><br/>';
        const result = JSON.parse(await service.request('/private/users/__SELF__'));
        html += 'result: <pre>' + phpPrintR(result) + '</pre>';
      } catch {
        return sendServer500(req, reply);
      }
      return reply.type('text/html; charset=UTF-8').send(html);
    },
  });
}
