// T03 parity harness: fetch each URL from the OLD app (PHP, :6999) and the NEW
// app (Fastify, :7000) logged in as the same user, normalize, and diff.
//
// Usage:
//   pnpm parity --task T10        # urls from plan/parity-routes.json
//   pnpm parity --urls /a,/b
// Env: OLD_APP_URL, APP_URL, PARITY_EMAIL, PARITY_PASSWORD (from .env).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------- args

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

let urls: string[] = [];
let taskName = 'adhoc';
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--task') {
    taskName = process.argv[++i] ?? fail('--task needs a value');
    const table = JSON.parse(fs.readFileSync(path.join(root, 'plan', 'parity-routes.json'), 'utf8')) as Record<string, string[]>;
    urls = table[taskName] ?? [];
  } else if (a === '--urls') {
    urls = (process.argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    fail(`unknown arg: ${a}`);
  }
}
if (urls.length === 0) fail('no urls: pass --task <ID> (see plan/parity-routes.json) or --urls /a,/b');
if (!config.PARITY_EMAIL || !config.PARITY_PASSWORD) fail('PARITY_EMAIL / PARITY_PASSWORD are not set in .env');

const OLD_BASE = config.OLD_APP_URL.replace(/\/+$/, '');
const NEW_BASE = config.APP_URL.replace(/\/+$/, '');

// ---------------------------------------------------------------- tiny cookie-jar fetch

class Jar {
  private cookies = new Map<string, string>();

  absorb(setCookie: string | string[] | null): void {
    for (const c of setCookie ?? []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function get(jar: Jar, base: string, url: string): Promise<Response> {
  return fetch(`${base}${url}`, {
    redirect: 'manual',
    headers: { cookie: jar.header(), 'user-agent': 'parity-harness' },
  });
}

async function postForm(jar: Jar, base: string, url: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${url}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: jar.header(),
      'user-agent': 'parity-harness',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
}

// ---------------------------------------------------------------- logins

// Old app: GET /login -> hidden `_token` + laravel_session cookie -> POST /login.
async function loginOld(): Promise<Jar> {
  const jar = new Jar();
  const page = await get(jar, OLD_BASE, '/login');
  jar.absorb(page.headers.getSetCookie());
  const html = await page.text();
  const token = /name="_token"\s+value="([^"]*)"/.exec(html)?.[1] ?? '';
  if (!token) throw new Error(`old app: no _token in /login (status ${page.status})`);
  const res = await postForm(jar, OLD_BASE, '/login', { email: config.PARITY_EMAIL, password: config.PARITY_PASSWORD, _token: token });
  jar.absorb(res.headers.getSetCookie());
  if (res.status !== 301 && res.status !== 302) {
    throw new Error(`old app login failed: status ${res.status}`);
  }
  return jar;
}

// New app: POST /login (CSRF is not enforced).
async function loginNew(): Promise<Jar> {
  const jar = new Jar();
  const res = await postForm(jar, NEW_BASE, '/login', { email: config.PARITY_EMAIL, password: config.PARITY_PASSWORD });
  jar.absorb(res.headers.getSetCookie());
  if (res.status !== 301 && res.status !== 302) {
    throw new Error(`new app login failed: status ${res.status}`);
  }
  return jar;
}

// ---------------------------------------------------------------- normalization

function normalizeHtml(html: string): string {
  return html
    .replaceAll(OLD_BASE, 'BASE')
    .replaceAll(NEW_BASE, 'BASE')
    // strip the old app's debug-mode PhpDebugBar injection (link + scripts;
    // includes non-deterministic query/timeline data)
    .replace(/<link rel='stylesheet'[^>]*\/_debugbar[\s\S]*<\/script>\s*(?=<\/body>|$)/, '') // T14: also when the debugbar lands at document end (after </html>, no </body>)
    // strip mix-manifest `?id=<hash>` asset versions and csrf/_token values
    .replace(/\?id=[a-f0-9]+/g, '')
    .replace(/(name="_token"[^>]*value=")[^"]*(")/g, '$1$2')
    .replace(/(name="csrf-token"[^>]*content=")[^"]*(")/g, '$1$2')
    // csrf tokens also appear in inline JS payloads (session-specific, per side)
    .replace(/(_token:\s*')[^']*(')/g, '$1$2')
    // T14: /chat's inline JS sends the session token as 'X-CSRF-TOKEN': '...'
    .replace(/('X-CSRF-TOKEN':\s*')[^']*(')/g, '$1$2')
    .replace(/>\s+</g, '><') // inter-tag whitespace (old pretty-prints some views)
    .replace(/\s+(<\/[a-z][a-z0-9]*>)/g, '$1') // text space right before a closing tag
    .replace(/(<\/?[a-z][a-z0-9]*[^>]*>)\s+/g, '$1') // text space right after a tag
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocation(loc: string | null): string {
  if (loc === null) return '';
  const l = loc.replaceAll(OLD_BASE, 'BASE').replaceAll(NEW_BASE, 'BASE');
  return l.startsWith('/') ? `BASE${l}` : l; // old app sends absolute Location
}

// ---------------------------------------------------------------- diff (unified, LCS)

function unifiedDiff(a: string, b: string, nameA: string, nameB: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = al.length;
  const m = bl.length;
  // LCS table (fine for page-sized inputs).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [`--- ${nameA}`, `+++ ${nameB}`];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      out.push(` ${al[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${al[i]}`);
      i++;
    } else {
      out.push(`+${bl[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${al[i++ as number]}`);
  while (j < m) out.push(`+${bl[j++ as number]}`);
  return out.join('\n');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

// ---------------------------------------------------------------- compare

interface Side {
  status: number;
  location: string | null;
  body: string;
  ct: string;
}

async function compare(label: string, oldJar: Jar, newJar: Jar): Promise<boolean> {
  const [ro, rn] = await Promise.all([get(oldJar, OLD_BASE, label), get(newJar, NEW_BASE, label)]);
  const side = async (r: Response): Promise<Side> => ({
    status: r.status,
    location: r.headers.get('location'),
    body: await r.text(),
    ct: r.headers.get('content-type') ?? '',
  });
  const [o, n] = await Promise.all([side(ro), side(rn)]);

  let ok = true;
  const problems: string[] = [];
  if (o.status !== n.status) problems.push(`status: old=${o.status} new=${n.status}`);
  if (normalizeLocation(o.location) !== normalizeLocation(n.location)) problems.push(`location: old=${o.location} new=${n.location}`);

  let bodyA: string;
  let bodyB: string;
  const ctIsJson = (ct: string) => ct.includes('json');
  if (ctIsJson(o.ct) || ctIsJson(n.ct)) {
    try {
      bodyA = JSON.stringify(JSON.parse(o.body), null, 2);
      bodyB = JSON.stringify(JSON.parse(n.body), null, 2);
      if (!deepEqual(JSON.parse(o.body), JSON.parse(n.body))) {
        ok = false;
        problems.push('json bodies differ');
      }
    } catch (e) {
      problems.push(`json parse failed: ${String(e)}`);
      bodyA = o.body;
      bodyB = n.body;
    }
  } else {
    bodyA = normalizeHtml(o.body);
    bodyB = normalizeHtml(n.body);
    if (bodyA !== bodyB) {
      ok = false;
      problems.push('html bodies differ');
    }
  }

  const outDir = path.join(root, '.parity', taskName);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.basename(label).replace(/[^A-Za-z0-9._-]/g, '_') || 'root';
  fs.writeFileSync(path.join(outDir, `${file}.old`), o.body);
  fs.writeFileSync(path.join(outDir, `${file}.new`), n.body);

  if (!ok) {
    const diff = unifiedDiff(bodyA.split(' ').join('\n'), bodyB.split(' ').join('\n'), `${label} (old)`, `${label} (new)`)
      .split('\n').slice(0, 80).join('\n');
    console.error(`\nFAIL ${label}\n  ${problems.join('\n  ')}\n${diff}`);
    return false;
  }
  console.log(`OK   ${label} (${o.status}${o.location ? ` -> ${o.location}` : ''})`);
  return true;
}

// ---------------------------------------------------------------- main

const [oldJar, newJar] = await Promise.all([loginOld(), loginNew()]);
let failures = 0;
for (const url of urls) {
  try {
    if (!(await compare(url, oldJar, newJar))) failures++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${url}: ${String(e)}`);
  }
}
console.log(failures === 0 ? `\nparity ${taskName}: all ${urls.length} pass` : `\nparity ${taskName}: ${failures}/${urls.length} failed`);
process.exit(failures === 0 ? 0 : 1);
