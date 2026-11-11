// Publishes one HTML page as the static assets of an existing Cloudflare Worker
// (the catalog's price-free index.html). Same three steps wrangler uses:
// upload session -> upload the files the session asks for -> deploy the Worker with the asset token.

import { createHash } from 'node:crypto';
import { config } from '../config.js';

const API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result: T;
}

export function cloudflareConfigured(): boolean {
  return Boolean(config.CLOUDFLARE_API_TOKEN && config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_WORKER);
}

async function call<T>(path: string, init: RequestInit, token = config.CLOUDFLARE_API_TOKEN): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !body?.success) {
    const why = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare: ${why}`);
  }
  return body.result;
}

export async function publishPage(html: string): Promise<string> {
  const account = config.CLOUDFLARE_ACCOUNT_ID;
  const worker = config.CLOUDFLARE_WORKER;
  const content = Buffer.from(html, 'utf8');
  const base64 = content.toString('base64');
  // wrangler's asset hash: sha256(base64 content + file extension), first 32 hex chars.
  const hash = createHash('sha256').update(base64 + 'html').digest('hex').slice(0, 32);

  const session = await call<{ jwt: string; buckets?: string[][] }>(
    `/accounts/${account}/workers/scripts/${worker}/assets-upload-session`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: { '/index.html': { hash, size: content.length } } }),
    },
  );

  let completion = session.jwt;
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const h of bucket) if (h === hash) form.append(h, new Blob([base64], { type: 'text/html' }), h);
    const uploaded = await call<{ jwt?: string }>(`/accounts/${account}/workers/assets/upload?base64=true`, { method: 'POST', body: form }, session.jwt);
    if (uploaded.jwt) completion = uploaded.jwt;
  }

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify({
      compatibility_date: new Date().toISOString().slice(0, 10),
      assets: { jwt: completion, config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' } },
    })], { type: 'application/json' }),
    'metadata.json',
  );
  await call(`/accounts/${account}/workers/scripts/${worker}`, { method: 'PUT', body: form });

  const sub = await call<{ subdomain?: string }>(`/accounts/${account}/workers/subdomain`, { method: 'GET' }).catch(() => ({ subdomain: '' }));
  return sub.subdomain ? `https://${worker}.${sub.subdomain}.workers.dev` : '';
}
