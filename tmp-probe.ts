import { config } from './src/config.js';
const base = process.env.BASE ?? config.OLD_APP_URL.replace(/\/+$/, '');
const cookies = new Map<string, string>();
const absorb = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [p] = c.split(';'); const i = p.indexOf('='); cookies.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
const ck = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
async function main() {
  const page = await fetch(base + '/login', { redirect: 'manual' }); absorb(page);
  const token = /name="_token"\s+value="([^"]*)"/.exec(await page.text())?.[1] ?? '';
  const l = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { cookie: ck(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: config.PARITY_EMAIL, password: config.PARITY_PASSWORD, _token: token }).toString() }); absorb(l);
  const reqs = JSON.parse(process.argv[2]) as { m: string; u: string; h?: Record<string, string>; b?: string }[];
  for (const r of reqs) {
    const res = await fetch(base + r.u, { method: r.m, redirect: 'manual', headers: { cookie: ck(), ...(r.h ?? {}) }, body: r.b });
    const t = await res.text();
    console.log(r.m, r.u, res.status, res.headers.get('content-type'), res.headers.get('location') ?? '');
    console.log(t.slice(0, Number(process.env.N ?? 600)));
    console.log('---');
  }
}
main();
