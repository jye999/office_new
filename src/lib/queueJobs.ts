// Laravel 5.4 redis queue: serialize(new App\Jobs\X(...)) + the payload envelope RedisQueue::pushRaw writes
// (RPUSH queues:default). Verified byte-for-byte against the old app's PHP 7.4 (test/queue-jobs.test.ts golden fixtures).
//
// SAFETY: the queue is shared with the old app's `queue:work`; a pushed label job is executed (and buys postage)
// by whichever worker pops it. Tests must use setQueuePushForTests.

import { randomBytes } from 'node:crypto';
import { Redis as IORedis } from 'ioredis';
import { config } from '../config.js';

export class PhpFloat {
  constructor(public v: number) {}
}

function sstr(s: string): string {
  return `s:${Buffer.byteLength(s, 'utf8')}:"${s}";`;
}

export function phpSerialize(v: unknown): string {
  if (v === null || v === undefined) return 'N;';
  if (v instanceof PhpFloat) return `d:${v.v};`;
  if (typeof v === 'boolean') return v ? 'b:1;' : 'b:0;';
  if (typeof v === 'number') return Number.isInteger(v) ? `i:${v};` : `d:${v};`;
  if (typeof v === 'string') return sstr(v);
  if (Array.isArray(v)) return `a:${v.length}:{${v.map((x, i) => `i:${i};${phpSerialize(x)}`).join('')}}`;
  const entries = Object.entries(v as Record<string, unknown>);
  return `a:${entries.length}:{${entries.map(([k, x]) => `${/^(0|-?[1-9]\d*)$/.test(k) ? `i:${k};` : sstr(k)}${phpSerialize(x)}`).join('')}}`;
}

export interface JobProp {
  name: string;
  value: unknown;
  visibility?: 'public' | 'protected'; // default protected
}

// Class-declared properties in declaration order, then the Queueable/InteractsWithQueue trait properties.
export function serializeJob(className: string, props: JobProp[]): string {
  const all: JobProp[] = [...props, { name: 'job', value: null }, { name: 'connection', value: null, visibility: 'public' }, { name: 'queue', value: null, visibility: 'public' }, { name: 'delay', value: null, visibility: 'public' }];
  const body = all.map((p) => `${sstr(p.visibility === 'public' ? p.name : `\0*\0${p.name}`)}${phpSerialize(p.value)}`).join('');
  return `O:${Buffer.byteLength(className, 'utf8')}:"${className}":${all.length}:{${body}}`;
}

// createPayload() + RedisQueue meta (random 32 char id, attempts 0). The Lua pop script does attempts+1, so both are required.
export function jobPayload(className: string, command: string, opts: { tries?: number | null; timeout?: number | null } = {}): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const id = Array.from(randomBytes(32), (b) => alphabet[b % alphabet.length]).join('');
  return JSON.stringify({
    displayName: className,
    job: 'Illuminate\\Queue\\CallQueuedHandler@call',
    maxTries: opts.tries ?? null,
    timeout: opts.timeout ?? null,
    data: { commandName: className, command },
    id,
    attempts: 0,
  });
}

let redis: IORedis | null = null;
function defaultQueuePush(payload: string, queue: string): Promise<void> {
  redis ??= new IORedis({ host: config.REDIS_HOST, port: config.REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 });
  // SAFETY: ioredis rpush resolves number|string on both redis replies; callers ignore the value.
  return redis.rpush(`queues:${queue}`, payload) as unknown as Promise<void>;
}
let queuePush: (payload: string, queue: string) => Promise<void> = defaultQueuePush;
// Test seam so unit tests never touch redis.
export function setQueuePushForTests(fn: ((payload: string, queue: string) => Promise<void>) | null): void {
  queuePush = fn ?? defaultQueuePush;
}

export async function dispatch(className: string, props: JobProp[], opts: { tries?: number | null; timeout?: number | null; queue?: string } = {}): Promise<void> {
  await queuePush(jobPayload(className, serializeJob(className, props), opts), opts.queue ?? 'default');
}

// ---- PHP numeric helpers used by the job constructors
export const isNumeric = (v: unknown): boolean => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v));
// `$oz + $lb * 16` on numeric request strings: int unless an operand looks like a float.
export function ozPlusLbTimes16(oz: unknown, lb: unknown): number | PhpFloat {
  const o = isNumeric(oz) ? oz : 0;
  if (!isNumeric(lb)) return typeof o === 'number' ? o : phpNum(o);
  const isF = (x: unknown) => typeof x === 'string' && /[.eE]/.test(x);
  const r = Number(o) + Number(lb) * 16;
  return isF(o) || isF(lb) ? new PhpFloat(r) : r;
}
function phpNum(x: unknown): number | PhpFloat {
  const n = Number(x);
  return typeof x === 'string' && /[.eE]/.test(x) ? new PhpFloat(n) : n;
}

// ---- jobs
const FROM_ADDRESS = {
  Company: 'Angel Isabella, LLC',
  Address1: '1550 Oak Industrial Lane',
  Address2: 'Ste F',
  City: 'Cumming',
  State: 'GA',
  ZIPCode: '30041',
  PostalCode: '30041',
  Country: 'US',
  PhoneNumber: '678-999-6232',
};

interface Dims { orders: unknown; lb: unknown; oz: unknown; length: unknown; width: unknown; height: unknown }

export function amzMassPrintLabelProps(a: Dims): JobProp[] {
  return [
    { name: 'fromAddress', value: FROM_ADDRESS },
    { name: 'tries', value: 1, visibility: 'public' },
    { name: 'firstClass', value: false },
    { name: 'orders', value: a.orders ?? null },
    { name: 'lb', value: a.lb ?? null },
    { name: 'oz', value: ozPlusLbTimes16(a.oz, a.lb) },
    { name: 'length', value: a.length ?? null },
    { name: 'width', value: a.width ?? null },
    { name: 'height', value: a.height ?? null },
    { name: 'currentJobId', value: null },
    { name: 'queuejob', value: null },
  ];
}
export const dispatchAmzMassPrintLabel = (a: Dims) => dispatch('App\\Jobs\\AmzMassPrintLabel', amzMassPrintLabelProps(a), { tries: 1 });

export function frayunMassPrintLabelProps(a: Dims & { packageType?: unknown }): JobProp[] {
  return [
    { name: 'timeout', value: 600, visibility: 'public' },
    { name: 'fromAddress', value: FROM_ADDRESS },
    { name: 'tries', value: 1, visibility: 'public' },
    { name: 'firstClass', value: false },
    { name: 'orders', value: a.orders ?? null },
    { name: 'lb', value: a.lb ?? null },
    { name: 'oz', value: a.oz ?? null },
    { name: 'length', value: a.length ?? null },
    { name: 'width', value: a.width ?? null },
    { name: 'height', value: a.height ?? null },
    { name: 'packageType', value: a.packageType ?? 'FIRST CLASS' },
    { name: 'declareValue', value: null },
    { name: 'insurance', value: null },
    { name: 'currentJobId', value: null },
    { name: 'queuejob', value: null },
  ];
}
export const dispatchFrayunMassPrintLabel = (a: Dims) => dispatch('App\\Jobs\\FrayunMassPrintLabel', frayunMassPrintLabelProps(a), { tries: 1, timeout: 600 });

export function massPrintLabelProps(a: Dims & { packageType: unknown; declareValue: unknown; insurance: unknown }): JobProp[] {
  return [
    { name: 'fromAddress', value: FROM_ADDRESS },
    { name: 'tries', value: 1, visibility: 'public' },
    { name: 'firstClass', value: false },
    { name: 'orders', value: a.orders ?? null },
    { name: 'lb', value: a.lb ?? null },
    { name: 'oz', value: a.oz ?? null },
    { name: 'length', value: a.length ?? null },
    { name: 'width', value: a.width ?? null },
    { name: 'height', value: a.height ?? null },
    { name: 'packageType', value: a.packageType ?? null },
    { name: 'declareValue', value: a.declareValue ?? null },
    { name: 'insurance', value: a.insurance ?? null },
    { name: 'currentJobId', value: null },
    { name: 'queuejob', value: null },
  ];
}
export const dispatchMassPrintLabel = (a: Parameters<typeof massPrintLabelProps>[0]) => dispatch('App\\Jobs\\MassPrintLabel', massPrintLabelProps(a), { tries: 1 });
