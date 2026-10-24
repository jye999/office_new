// L06: App\Libraries\EtsyClient (+ lusitanian OAuth1 Etsy service, startz/oauth2-etsy provider) port. Nothing reaches Etsy:
// every call goes through setEtsyTransportForTests. The OAuth1 Authorization headers are golden values produced by running
// the old app's vendor code (docker exec office php, fixed srand(42), capture-only HTTP client, nothing sent).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EtsyClient,
  EtsyError,
  EtsyIdentityProviderError,
  EtsyOAuth1,
  EtsyOAuth2Provider,
  httpBuildQuery,
  setEtsyTransportForTests,
  type EtsyRequest,
  type EtsyResponse,
} from '../src/lib/etsy.js';

const NONCES = [
  'YRUoOXeWeJIqQgr5J0vURS2XntT4dJWU',
  'z6jgj9mQu1p6V4hgn8qralMdrk9uiqs1',
  'ArzQjRbvOlMBx2UnSR7leQ4e0Zn0Xrzx',
];
const TS = 1792805703;
// The token-flow golden comes from a second PHP run with a fresh service (the first run's signature object kept 'tsec').
const TS_FLOW = 1792805776;
const header = (nonce: string, token: string | null, sig: string, ts = TS) =>
  `OAuth oauth_callback="", oauth_consumer_key="ck", oauth_nonce="${nonce}", oauth_signature_method="HMAC-SHA1", ` +
  `oauth_timestamp="${ts}", oauth_version="1.0"${token ? `, oauth_token="${token}"` : ''}, oauth_signature="${sig}"`;

let calls: EtsyRequest[];
let replies: EtsyResponse[];
const ok = (body: string): EtsyResponse => ({ status: 200, reason: 'OK', body });

beforeEach(() => {
  Object.assign(process.env, {
    ETSY_CONSUMER_KEY1: 'ck', ETSY_CONSUMER_SECRET1: 'cs', ETSY_TOKEN1: 'tok', ETSY_SECRET1: 'tsec',
    ETSY_CONSUMER_KEY2: 'ck2', ETSY_CONSUMER_SECRET2: 'cs2', ETSY_TOKEN2: 'tok2', ETSY_SECRET2: 'tsec2',
  });
  delete process.env.DRY_RUN;
  calls = [];
  replies = [];
  setEtsyTransportForTests(async (req) => {
    calls.push(req);
    return replies.shift() ?? ok('{}');
  });
});
afterEach(() => setEtsyTransportForTests(null));

function oauth1(): EtsyOAuth1 {
  const n = [...NONCES];
  const svc = new EtsyOAuth1('ck', 'cs', { now: () => TS, nonce: () => n.shift() as string });
  svc.storeAccessToken({ accessToken: 'tok', accessTokenSecret: 'tsec' });
  return svc;
}

describe('EtsyOAuth1 (lusitanian Etsy service) matches the PHP library byte-for-byte', () => {
  it('signs an absolute GET with query params', async () => {
    await oauth1().request('https://openapi.etsy.com/v3/application/shops/__SELF__/receipts?limit=100&offset=1&was_paid=true&was_shipped=false');
    expect(calls[0]).toEqual({
      method: 'GET',
      url: 'https://openapi.etsy.com/v3/application/shops/__SELF__/receipts?limit=100&offset=1&was_paid=true&was_shipped=false',
      headers: { Authorization: header(NONCES[0], 'tok', 'x2%2Bs%2B%2FIQOVCJJtnT4YDLYKGV1UM%3D'), 'User-Agent': 'PHPoAuthLib' },
      body: undefined,
    });
  });

  it('resolves a relative path against https://openapi.etsy.com/v2/', async () => {
    const svc2 = new EtsyOAuth1('ck', 'cs', { now: () => TS, nonce: () => NONCES[1] });
    svc2.storeAccessToken({ accessToken: 'tok', accessTokenSecret: 'tsec' });
    await svc2.request('/countries');
    expect(calls[0].url).toBe('https://openapi.etsy.com/v2/countries');
    expect(calls[0].headers.Authorization).toBe(header(NONCES[1], 'tok', '%2F99eI15vRF9J8F9SgLS13vhFvc4%3D'));
  });

  it('signs a POST including the form body params and sends them urlencoded', async () => {
    const svc = new EtsyOAuth1('ck', 'cs', { now: () => TS, nonce: () => NONCES[2] });
    svc.storeAccessToken({ accessToken: 'tok', accessTokenSecret: 'tsec' });
    await svc.request('https://openapi.etsy.com/v3/application/shops/__SELF__/receipts/123/tracking', 'POST', { tracking_code: '1Z 99/x', carrier_name: 'USP' });
    expect(calls[0]).toEqual({
      method: 'POST',
      url: 'https://openapi.etsy.com/v3/application/shops/__SELF__/receipts/123/tracking',
      headers: {
        Authorization: header(NONCES[2], 'tok', '2AjFuMo5IBFDMkTCORSE4d89u%2BQ%3D'),
        'User-Agent': 'PHPoAuthLib',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'tracking_code=1Z+99%2Fx&carrier_name=USP',
    });
  });

  it('request token + access token flow (v2 oauth endpoints, stored request token reused)', async () => {
    const n = [NONCES[0], NONCES[1]];
    const svc = new EtsyOAuth1('ck', 'cs', { now: () => TS_FLOW, nonce: () => n.shift() as string });
    replies.push(ok('oauth_token=rt&oauth_token_secret=rs&oauth_callback_confirmed=true&login_url=https%3A%2F%2Fwww.etsy.com%2Foauth%2Fsignin%3Foauth_token%3Drt'));
    const rt = await svc.requestRequestToken();
    expect(calls[0].url).toBe('https://openapi.etsy.com/v2/oauth/request_token');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe('');
    expect(calls[0].headers.Authorization).toBe(header(NONCES[0], null, 'AVu3kBpwvztm0Jn74GUZ8IirQZg%3D', TS_FLOW));
    expect(rt.extraParams).toEqual({ oauth_callback_confirmed: 'true', login_url: 'https://www.etsy.com/oauth/signin?oauth_token=rt' });

    replies.push(ok('oauth_token=at&oauth_token_secret=as'));
    const at = await svc.requestAccessToken('rt', 'ver');
    expect(calls[1].url).toBe('https://openapi.etsy.com/v2/oauth/access_token');
    expect(calls[1].body).toBe('oauth_verifier=ver');
    expect(calls[1].headers.Authorization).toBe(header(NONCES[1], 'rt', 'ALnBwmM4jJd65e%2FN3GdOlNelR3c%3D', TS_FLOW));
    expect(at.accessToken).toBe('at');
    expect(svc.retrieveAccessToken().accessTokenSecret).toBe('as');
  });

  it('request token without oauth_callback_confirmed fails like the PHP', async () => {
    replies.push(ok('oauth_token=rt&oauth_token_secret=rs'));
    await expect(new EtsyOAuth1('ck', 'cs').requestRequestToken()).rejects.toThrow('Error in retrieving token.');
  });

  it('non-2xx throws the file_get_contents failure text; GET with a body is rejected', async () => {
    replies.push({ status: 401, reason: 'Unauthorized', body: 'oauth_problem=x' });
    await expect(oauth1().request('https://openapi.etsy.com/v3/application/transactions/1')).rejects.toThrow(
      'file_get_contents(https://openapi.etsy.com/v3/application/transactions/1): failed to open stream: HTTP request failed! HTTP/1.1 401 Unauthorized',
    );
    await expect(oauth1().request('/countries', 'GET', { a: '1' })).rejects.toThrow('No body expected for "GET" request.');
  });

  it('request without a stored token throws', async () => {
    await expect(new EtsyOAuth1('ck', 'cs').request('/countries')).rejects.toThrow(EtsyError);
  });
});

describe('EtsyClient', () => {
  it('getOrders: URL, env credentials, lines <= 10 bytes dropped, returns results', async () => {
    replies.push(ok('{"count":1,\r\n"results":[{"receipt_id":5}]}'));
    const r = await new EtsyClient(1).getOrders(3);
    expect(calls[0].url).toBe('https://openapi.etsy.com/v3/application/shops/__SELF__/receipts?limit=100&offset=3&was_paid=true&was_shipped=false');
    expect(calls[0].headers.Authorization).toMatch(/^OAuth oauth_callback="", oauth_consumer_key="ck", .*oauth_token="tok", oauth_signature="/);
    // `{"count":1,` is 11 bytes and kept; the glued result is valid JSON.
    expect(r).toEqual([{ receipt_id: 5 }]);
  });

  it('getOrders: drops short lines and returns null without results', async () => {
    replies.push(ok('{"error":"nope"}'));
    expect(await new EtsyClient(1).getOrders()).toBeNull();
    expect(calls[0].url).toContain('offset=1&');
    replies.push(ok('{"results":\r\n[1]\r\n}')); // "[1]" and "}" are short lines -> JSON broken -> null
    expect(await new EtsyClient(1).getOrders()).toBeNull();
  });

  it('getCountries maps country_id -> iso_country_code via the v2 base URI', async () => {
    replies.push(ok(JSON.stringify({ count: 2, results: [{ country_id: 209, iso_country_code: 'US' }, { country_id: 79, iso_country_code: 'DE' }] })));
    expect(await new EtsyClient(1).getCountries()).toEqual({ 209: 'US', 79: 'DE' });
    expect(calls[0].url).toBe('https://openapi.etsy.com/v2/countries');
    replies.push(ok('garbage'));
    expect(await new EtsyClient(1).getCountries()).toEqual({});
  });

  it('getAllListing / getCategories URLs and decoded replies; store 2 uses ETSY_*2 credentials', async () => {
    replies.push(ok('{"count":0,"results":[]}'), ok('{"results":[{"title":"A"}]}'));
    const c = new EtsyClient(2);
    expect(await c.getAllListing(4)).toEqual({ count: 0, results: [] });
    expect(calls[0].url).toBe('https://openapi.etsy.com/v3/application/shops/__SELF__/listings/active?limit=100&page=4&includes=Images,MainImage');
    expect(calls[0].headers.Authorization).toContain('oauth_consumer_key="ck2"');
    expect(calls[0].headers.Authorization).toContain('oauth_token="tok2"');
    expect(await c.getCategories()).toEqual({ results: [{ title: 'A' }] });
    expect(calls[1].url).toBe('https://openapi.etsy.com/v3/application/shops/__SELF__/sections');
  });

  it('getListingById calls the n8n webhook (T / T<store>), no OAuth header; failures -> null', async () => {
    replies.push(ok('{"count":1}'));
    expect(await new EtsyClient(1).getListingById(77)).toEqual({ count: 1 });
    expect(calls[0]).toEqual({
      method: 'GET',
      url: 'https://flow.angelisabella.com/webhook/15dea4d4-d58f-4d34-a13b-3bc04b9eb337/15dea4d4-d58f-4d34-a13b-3bc04b9eb337/T/77',
      headers: {},
    });
    replies.push(ok('x'));
    await new EtsyClient(2).getListingById(8);
    expect(calls[1].url.endsWith('/T2/8')).toBe(true);
    setEtsyTransportForTests(async () => {
      throw new Error('down');
    });
    expect(await new EtsyClient(1).getListingById(1)).toBeNull();
  });

  it('getTransaction: [] without results, the PHP undefined-$oauth fatal when there are results', async () => {
    replies.push(ok('{"transaction_id":1}'));
    expect(await new EtsyClient(1).getTransaction(1)).toEqual([]);
    expect(calls[0].url).toBe('https://openapi.etsy.com/v3/application/transactions/1?limit=100');
    replies.push(ok('{"results":[{"listing_id":2}]}'));
    await expect(new EtsyClient(1).getTransaction(1)).rejects.toThrow('Call to a member function fetch() on null');
  });

  it.each([
    ['1Z999AA10123456784', 'USP'],
    ['9400111899223344556677', 'USPS'],
    ['1234567890123', 'USPS'],
    ['123456789012', 'Fedex'],
    ['1Z', 'USP'],
  ])('postTracking %s -> carrier_name %s', async (tracking, carrier) => {
    await new EtsyClient(1).postTracking(555, tracking);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://openapi.etsy.com/v3/application/shops/__SELF__/receipts/555/tracking');
    expect(calls[0].body).toBe(`tracking_code=${tracking}&carrier_name=${carrier}`);
  });

  it('DRY_RUN=1: postTracking is not sent, reads still are', async () => {
    process.env.DRY_RUN = '1';
    await expect(new EtsyClient(1).postTracking(555, '1Z1')).rejects.toThrow('DRY_RUN');
    expect(calls).toHaveLength(0);
    replies.push(ok('{"results":[1]}'));
    await new EtsyClient(1).getOrders();
    expect(calls).toHaveLength(1);
  });
});

describe('EtsyOAuth2Provider (startz/oauth2-etsy)', () => {
  const provider = () => new EtsyOAuth2Provider({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://localhost:7000/etsy-callback-url' });

  it('PKCE challenge / pre-challenge match the PHP provider', () => {
    const p = provider();
    expect(p.getPKCE('abcDEF123-_verifier')).toBe('aIBbqx26kL39Bp0x06AKL_dOVXdAbAzV-MPggeGHbVI');
    expect(p.getPreChallenge()).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it('getAuthorizationUrl: same parameter order and RFC3986 encoding as PHP', () => {
    const p = provider();
    expect(p.getAuthorizationUrl({ code_challenge: 'CH', code_challenge_method: 'S256', scope: ['email_r', 'listings_r', 'shops_w'], state: 'st8' })).toBe(
      'https://www.etsy.com/oauth/connect?code_challenge=CH&code_challenge_method=S256&scope=email_r%20listings_r%20shops_w&state=st8&response_type=code&approval_prompt=auto&redirect_uri=http%3A%2F%2Flocalhost%3A7000%2Fetsy-callback-url&client_id=cid',
    );
    expect(p.getState()).toBe('st8');
    expect(p.getAuthorizationUrl({ state: 'x' })).toBe(
      'https://www.etsy.com/oauth/connect?state=x&scope=email_r&response_type=code&approval_prompt=auto&redirect_uri=http%3A%2F%2Flocalhost%3A7000%2Fetsy-callback-url&client_id=cid',
    );
    expect(p.getAuthorizationUrl({}).match(/state=[0-9a-f]{32}&/)).not.toBeNull();
  });

  it('getAccessToken posts the params in URL query AND body with the x-api-key header', async () => {
    replies.push(ok('{"access_token":"123.abc","refresh_token":"123.ref","expires_in":3600,"token_type":"Bearer"}'));
    const t = await provider().getAccessToken('authorization_code', { code: 'C', code_verifier: 'V' });
    const qs = 'client_id=cid&client_secret=sec&redirect_uri=http%3A%2F%2Flocalhost%3A7000%2Fetsy-callback-url&grant_type=authorization_code&code=C&code_verifier=V';
    expect(calls[0]).toEqual({
      method: 'POST',
      url: `https://openapi.etsy.com/v3/public/oauth/token?${qs}`,
      headers: { 'x-api-key': 'cid', 'content-type': 'application/x-www-form-urlencoded' },
      body: qs,
    });
    expect(t.accessToken).toBe('123.abc');
    expect(t.refreshToken).toBe('123.ref');
    expect(t.expires).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
  });

  it('error replies become EtsyIdentityProviderError (message, else reason phrase)', async () => {
    replies.push({ status: 400, reason: 'Bad Request', body: '{"error":"invalid_grant","error_description":"x"}' });
    await expect(provider().getAccessToken('authorization_code', { code: 'C' })).rejects.toThrow(EtsyIdentityProviderError);
    replies.push({ status: 401, reason: 'Unauthorized', body: '{"message":"bad key"}' });
    await expect(provider().getAccessToken('authorization_code', { code: 'C' })).rejects.toThrow('bad key');
    replies.push(ok('{"error":"oops"}'));
    await expect(provider().getAccessToken('authorization_code', { code: 'C' })).rejects.toThrow('oops');
    replies.push(ok('not json'));
    await expect(provider().getAccessToken('authorization_code', { code: 'C' })).rejects.toThrow('Expected JSON');
  });

  it('getResourceOwner: GET /application/users/<id prefix> with api key and Bearer token', async () => {
    replies.push(ok('{"user_id":123}'));
    const owner = await provider().getResourceOwner({ accessToken: '123.abc', values: {} });
    expect(calls[0]).toEqual({
      method: 'GET',
      url: 'https://openapi.etsy.com/v3/application/users/123',
      headers: { 'x-api-key': 'cid', Authorization: 'Bearer 123.abc' },
    });
    expect(owner).toEqual({ user_id: 123 });
  });
});

describe('httpBuildQuery', () => {
  it('RFC1738 default (space -> +, ~ -> %7E) vs RFC3986, skipping null', () => {
    expect(httpBuildQuery({ a: 'x y~', b: null, c: true })).toBe('a=x+y%7E&c=1');
    expect(httpBuildQuery({ a: 'x y~' }, true)).toBe('a=x%20y~');
  });
});
