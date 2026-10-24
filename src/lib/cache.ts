// Laravel 5.4 redis cache store (CACHE_DRIVER=redis, prefix 'laravel'): `laravel:<key>`, SETEX minutes*60,
// numbers stored raw, everything else PHP-serialized. Shared with the old app (same redis db 0).
// Only strings/numbers are supported — the only values the ported code caches.

import { Redis as IORedis } from 'ioredis';
import { config } from '../config.js';

export interface CacheBackend {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
}

let redis: IORedis | null = null;
const defaultBackend: CacheBackend = {
  get: (k) => (redis ??= new IORedis({ host: config.REDIS_HOST, port: config.REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 })).get(k),
  setex: (k, s, v) => (redis ??= new IORedis({ host: config.REDIS_HOST, port: config.REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 })).setex(k, s, v),
};
let backend: CacheBackend = defaultBackend;
// Test seam so unit tests never touch the shared redis.
export function setCacheBackendForTests(b: CacheBackend | null): void {
  backend = b ?? defaultBackend;
}

const PREFIX = 'laravel:';
const isNumeric = (v: unknown): boolean => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));

// Cache::get($key) -> string | number | null
export async function cacheGet(key: string): Promise<string | number | null> {
  const raw = await backend.get(PREFIX + key);
  if (raw === null) return null;
  if (isNumeric(raw)) return Number(raw);
  const m = /^s:(\d+):"([\s\S]*)";$/.exec(raw);
  if (!m) throw new Error(`cache value for ${key} is not a serialized string`);
  return m[2];
}

export async function cacheHas(key: string): Promise<boolean> {
  return (await cacheGet(key)) !== null;
}

// Cache::put($key, $value, $minutes)
export async function cachePut(key: string, value: string | number, minutes: number): Promise<void> {
  const ser = typeof value === 'number' ? String(value) : `s:${Buffer.byteLength(value, 'utf8')}:"${value}";`;
  await backend.setex(PREFIX + key, Math.max(1, Math.trunc(minutes * 60)), ser);
}
