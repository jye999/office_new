// Blade-compatible Nunjucks view engine + PHP/Laravel helper globals.
// See plan/CONVENTIONS.md "Blade → Nunjucks" for the mapping contract.

import fastifyFlash from '@fastify/flash';
import fastifySecureSession from '@fastify/secure-session';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import nunjucks from 'nunjucks';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as appConfig } from './config.js';
import { routeUrl } from './router.js';
import { langEn } from './lang/en.js';
import { currentUser, hasRole as roleCheck, type Auth } from './auth.js';

// ---------------------------------------------------------------- env

export const viewsDir = path.join(process.cwd(), 'views');

// Autoescape on (same as Blade's {{ }}), undefined vars render empty
// (same as PHP with warnings suppressed — the old app runs with E_ALL|E_STRICT off).
export function createViewEnv(viewsRoot: string = viewsDir): nunjucks.Environment {
  return new nunjucks.Environment(new nunjucks.FileSystemLoader(viewsRoot), {
    autoescape: true,
    throwOnUndefined: false,
  });
}

const njkEnv = createViewEnv();

// JSON-ish dynamic values crossing the PHP/Blade -> template boundary
// (session data, config values, request input, model attributes).
interface TemplateValueMap { [key: string]: TemplateValue }
export type TemplateValue = string | number | boolean | null | undefined | TemplateValue[] | TemplateValueMap;

// ---------------------------------------------------------------- PHP helpers (template globals)

// htmlspecialchars($value, ENT_QUOTES, 'UTF-8')
export function e(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// isset(): false only for null/undefined (never for '' or 0).
export function isset(value: unknown): boolean {
  return value !== null && value !== undefined;
}

// PHP empty(): null, '', 0, '0', false, [] and {} are empty.
export function phpEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '' || value === '0';
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'boolean') return !value;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

export function is_array(value: unknown): boolean {
  return Array.isArray(value);
}

export function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return 1; // PHP: count("str") === 1 (with warning)
  return 0;
}

// PHP in_array loose mode: string-coerce comparison (strict mode: ===).
export function in_array(needle: unknown, arr: unknown[], strict = false): boolean {
  if (!Array.isArray(arr)) return false;
  if (strict) return arr.some((v) => v === needle);
  return arr.some((v) => String(v) === String(needle));
}

export function explode(delimiter: string, value: string): string[] {
  return delimiter === '' ? [] : value.split(delimiter);
}

export function implode(glue: string, arr: unknown[]): string {
  return arr.map(String).join(glue);
}

export function strtoupper(s: string): string {
  return String(s ?? '').toUpperCase();
}

export function ucfirst(s: string): string {
  const str = String(s ?? '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// PHP round(): half away from zero. toPrecision(15) removes float representation
// noise (1.255 * 100 -> 125.5, not 125.4999...); exact decimal half-edges can still
// drift a ulp (e.g. 1.005, 0.145) — same class of limitation as PHP's double math.
export function round(value: number, precision = 0): number {
  const sign = value < 0 ? -1 : 1;
  const scaled = Number(Number(Math.abs(value).toPrecision(15)) * 10 ** precision);
  return sign * Math.round(scaled) / 10 ** precision;
}

// PHP number_format().
export function number_format(value: number, dec = 0, decPoint = '.', thousandsSep = ','): string {
  const neg = value < 0;
  let s = Math.abs(value).toFixed(dec);
  let [int, frac] = s.split('.');
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSep);
  if (dec > 0 && frac === undefined) frac = '0'.repeat(dec);
  return (neg ? '-' : '') + int + (frac !== undefined ? decPoint + frac : '');
}

// PHP substr() with negative-start support.
export function substr(s: string, start: number, length?: number): string {
  let str = String(s ?? '');
  if (start < 0) start = Math.max(0, str.length + start);
  if (start >= str.length) return '';
  if (length === undefined) return str.slice(start);
  if (length <= 0) return '';
  return str.slice(start, start + length);
}

// PHP json_encode defaults: `\/` escaping, non-ASCII as \uXXXX.
export function json_encode(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    let out = '';
    for (const ch of value) {
      const code = ch.codePointAt(0)!;
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '/') out += '\\/';
      else if (ch === '\b') out += '\\b';
      else if (ch === '\f') out += '\\f';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else if (code > 0x7f) {
        for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
      } else out += ch;
    }
    return `"${out}"`;
  }
  if (Array.isArray(value)) return `[${value.map(json_encode).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${json_encode(k)}:${json_encode(v)}`)
      .join(',')}}`;
  }
  return 'null';
}

// PHP nl2br() (no escaping, <br /> + newline).
export function nl2br(value: string): string {
  return String(value ?? '')
    .replace(/\r\n/g, '<br />\n')
    .replace(/\n/g, '<br />\n')
    .replace(/\r/g, '<br />');
}

// PHP date() format chars, in the app timezone.
export function date(format: string, ts?: number | Date): string {
  const dateObj = ts instanceof Date ? ts : new Date((ts ?? Math.floor(Date.now() / 1000)) * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: appConfig.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(dateObj);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const y = Number(get('year'));
  const mo = Number(get('month'));
  const d = Number(get('day'));
  const h = Number(get('hour'));
  const mi = Number(get('minute'));
  const s = Number(get('second'));
  // Shift to a UTC date carrying the app-timezone wall clock so UTC getters give tz fields.
  const offsetMs = dateObj.getTime() - Date.UTC(y, mo - 1, d, h, mi, s);
  const u = new Date(dateObj.getTime() - offsetMs);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const dayOfYear = Math.floor((u.getTime() - Date.UTC(y, 0, 1)) / 86400000) + 1;
  // ISO-8601 week number.
  const iso = new Date(Date.UTC(y, mo - 1, d));
  const dayNum = iso.getUTCDay() || 7;
  iso.setUTCDate(iso.getUTCDate() + 4 - dayNum);
  const isoYearStart = Date.UTC(iso.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((iso.getTime() - isoYearStart) / 86400000 + 1) / 7);
  const offsetSec = Math.round(offsetMs / 1000);
  const sign = offsetSec >= 0 ? '+' : '-';
  const absOff = Math.abs(offsetSec);
  const offH = String(Math.floor(absOff / 3600)).padStart(2, '0');
  const offM = String(Math.floor((absOff % 3600) / 60)).padStart(2, '0');
  const monthLong = new Intl.DateTimeFormat('en-GB', { timeZone: appConfig.APP_TIMEZONE, month: 'long' }).format(dateObj);
  const monthShort = new Intl.DateTimeFormat('en-GB', { timeZone: appConfig.APP_TIMEZONE, month: 'short' }).format(dateObj);
  const dayLong = new Intl.DateTimeFormat('en-GB', { timeZone: appConfig.APP_TIMEZONE, weekday: 'long' }).format(dateObj);

  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '\\') {
      i++;
      out += format[i] ?? '';
      continue;
    }
    switch (c) {
      case 'd': out += String(d).padStart(2, '0'); break;
      case 'D': out += get('weekday'); break;
      case 'j': out += String(d); break;
      case 'l': out += dayLong; break;
      case 'N': out += String(u.getUTCDay() || 7); break;
      const suf = ['th', 'st', 'nd', 'rd'];
        const m10 = d % 10;
        const m100 = d % 100;
        out += m100 >= 11 && m100 <= 13 ? 'th' : (suf[m10] ?? 'th');
        break;
      case 'w': out += String(u.getUTCDay()); break;
      case 'z': out += String(dayOfYear); break;
      case 'W': out += String(week).padStart(2, '0'); break;
      case 'F': out += monthLong; break;
      case 'm': out += String(mo).padStart(2, '0'); break;
      case 'M': out += monthShort; break;
      case 'n': out += String(mo); break;
      case 't': out += String(daysInMonth); break;
      case 'L': out += String(Number(new Date(Date.UTC(y, 1, 29)).getUTCDate() === 29)); break;
      case 'Y': out += String(y); break;
      case 'y': out += String(y).slice(-2); break;
      case 'a': out += h < 12 ? 'am' : 'pm'; break;
      case 'A': out += h < 12 ? 'AM' : 'PM'; break;
      case 'g': out += String(h % 12 || 12); break;
      case 'G': out += String(h); break;
      case 'h': out += String(h % 12 || 12).padStart(2, '0'); break;
      case 'H': out += String(h).padStart(2, '0'); break;
      case 'i': out += String(mi).padStart(2, '0'); break;
      case 's': out += String(s).padStart(2, '0'); break;
      case 'u': out += '000000'; break;
      case 'e': out += appConfig.APP_TIMEZONE; break;
      case 'I': out += '0'; break;
      case 'O': out += `${sign}${offH}:${offM}`; break;
      case 'P': out += `${sign}${offH}:${offM}`; break;
      case 'T': out += appConfig.APP_TIMEZONE; break;
      case 'Z': out += String(offsetSec); break;
      case 'B': throw new Error('date(): Swatch (B) format not supported');
      case 'c': out += `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}${sign}${offH}:${offM}`; break;
      case 'r': out += `${get('weekday')}, ${String(d).padStart(2, '0')} ${monthShort} ${y} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')} ${sign}${offH}:${offM}`; break;
      case 'U': out += String(Math.floor(dateObj.getTime() / 1000)); break;
      default: out += c;
    }
  }
  return out;
}

// env() — Laravel's env() in a rendered page returns the raw value; in the old
// app (config cached in Docker) it returns null for most keys. Mirrors process env.
export function env(key: string): string | null {
  const v = process.env[key];
  return v === undefined ? null : v;
}

// Port of PHP `$messages[mt_rand(0, n-1)]` used by views/error/*.
export function randomOf(arr: TemplateValue[]): TemplateValue {
  return arr[Math.floor(Math.random() * arr.length)];
}

// config('app.name') — dot-path lookup over the ported config values.
const configValues: Record<string, Record<string, unknown>> = {
  app: {
    name: 'Angel Isabella', // config/app.php 'name'
    locale: 'en',
    url: appConfig.APP_URL,
    timezone: appConfig.APP_TIMEZONE,
  },
};

export function config(key: string, def?: TemplateValue): TemplateValue {
  const [group, ...rest] = key.split('.');
  const cur = configValues[group]?.[rest.join('.')] as TemplateValue | undefined;
  if (cur !== undefined) return cur;
  return def;
}

// trans('validation.required') / Lang::get('auth.failed', repl).
export function trans(key: string, repl?: Record<string, unknown>): string {
  const [group, ...rest] = key.split('.');
  const file = (langEn as Record<string, unknown>)[group];
  let value: unknown = file;
  for (const part of rest) {
    if (value && typeof value === 'object') value = (value as Record<string, unknown>)[part];
    else value = undefined;
  }
  if (typeof value !== 'string') return key;
  let out = value;
  if (repl) for (const [k, v] of Object.entries(repl)) out = out.replace(`:${k}`, String(v));
  return out;
}

// ---------------------------------------------------------------- URLs

// Laravel url(): absolute, APP_URL-based. `url()` -> APP_URL; `url('x')` -> APP_URL/x;
// params become the query string.
export function url(path = '', params?: Record<string, unknown>): string {
  const base = appConfig.APP_URL.replace(/\/+$/, '');
  const p = String(path).replace(/^\/+/, '');
  let out = p ? `${base}/${p}` : base;
  if (params) {
    // http_build_query semantics: spaces become '+'
    const q = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k).replace(/%20/g, '+')}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
      .join('&');
    if (q) out += `?${q}`;
  }
  return out;
}

// Laravel asset(): absolute paths pass through, else APP_URL-based like url().
export function asset(path = ''): string {
  if (/^([a-z][a-z0-9+.-]*:)?\/\/|^data:|^blob:/i.test(path)) return path;
  return url(path);
}

// route('name', params) — Laravel returns a relative path; absolute callers use url().
export function route(name: string, params?: Record<string, unknown>): string {
  return routeUrl(name, params);
}

// ---------------------------------------------------------------- MessageBag

export interface MessageBag {
  has(key: string): boolean;
  first(key: string): string | null;
  get(key: string): string[];
  all(): string[];
  any(): boolean;
  count(): number;
}

export function makeMessageBag(errors: Record<string, string[]> = {}): MessageBag {
  const data: Record<string, string[]> = Object.fromEntries(
    Object.entries(errors).map(([k, v]) => [k, Array.isArray(v) ? v : [String(v)]]),
  );
  return {
    has: (key) => key in data,
    first: (key) => data[key]?.[0] ?? null,
    get: (key) => data[key] ?? [],
    all: () => Object.values(data).flat(),
    any: () => Object.values(data).some((v) => v.length > 0),
    count: () => Object.values(data).reduce((n, v) => n + v.length, 0),
  };
}

// ---------------------------------------------------------------- Form builder
// Port of laravelcollective/html 5.2 FormBuilder (vendor/.../FormBuilder.php):
// identical markup including attribute order.

type Attrs = Record<string, unknown>;

// HtmlBuilder::attributes(): leading space, skip null, bool -> bare key.
function serializeAttributes(attrs: Attrs): string {
  const html: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'boolean') {
      if (value && key !== 'value') html.push(key);
      continue;
    }
    html.push(`${key}="${e(value)}"`);
  }
  return html.length > 0 ? ` ${html.join(' ')}` : '';
}

export interface FormBuilderContext {
  token: () => string;
  oldInput: (name: string) => TemplateValue;
  requestInput: (name: string) => TemplateValue;
  errorsAny: () => boolean;
  currentUrl: () => string;
  absoluteUrl: (path?: string) => string;
}

const SKIP_VALUE_TYPES = ['file', 'password', 'checkbox', 'radio'];
const SPOOFED_METHODS = ['DELETE', 'PATCH', 'PUT'];

export class FormBuilder {
  private labels: string[] = [];
  private boundModel: Record<string, TemplateValue> | null = null;

  constructor(private ctx: FormBuilderContext) {}

  // Form::open([...]) — attribute order: method, action, accept-charset, then options.
  open(options: Attrs = {}): string {
    const rawMethod = String(options['method'] ?? 'post').toUpperCase();
    const method = rawMethod !== 'GET' ? 'POST' : rawMethod;

    let action: string;
    if ('url' in options) action = this.ctx.absoluteUrl(String(options['url']));
    else if ('route' in options) action = routeUrl(String(options['route']));
    else action = this.ctx.currentUrl();

    const opts = { ...options };
    if (opts['files']) opts['enctype'] = 'multipart/form-data';

    const attributes: Attrs = {
      method,
      action,
      'accept-charset': 'UTF-8',
      ...Object.fromEntries(Object.entries(opts).filter(([k]) => !['method', 'url', 'route', 'action', 'files'].includes(k))),
    };

    let appendage = '';
    if (SPOOFED_METHODS.includes(rawMethod)) appendage += this.hidden('_method', rawMethod);
    if (method !== 'GET') appendage += this.token();

    return `<form${serializeAttributes(attributes)}>${appendage}`;
  }

  // Form::model($model, [...]) — sets the model as value source, then open().
  model(model: Record<string, unknown>, options: Attrs = {}): string {
    this.boundModel = model as Record<string, TemplateValue>;
    return this.open(options);
  }

  close(): string {
    this.labels = [];
    this.boundModel = null;
    return '</form>';
  }

  // Form::token() — hidden CSRF field.
  token(): string {
    return this.hidden('_token', this.ctx.token());
  }

  // Form::label($name, $value, $options) — note: `for` is hardcoded, options as-is.
  label(name: string, value?: unknown, options: Attrs = {}): string {
    this.labels.push(name);
    const text = value ? String(value) : name.split('_').map(ucfirst).join(' ');
    return `<label for="${e(name)}"${serializeAttributes(options)}>${e(text)}</label>`;
  }

  // Form::input($type, $name, $value, $options) — order: options..., name, type, value, id.
  input(type: string, name: string | null, value: unknown, options: Attrs = {}): string {
    const opts: Attrs = { ...options };
    if (!('name' in opts)) opts['name'] = name;

    const id = 'id' in opts
      ? opts['id']
      : name !== null && this.labels.includes(name)
        ? name
        : undefined;

    let val: unknown;
    if (!SKIP_VALUE_TYPES.includes(type)) val = this.getValueAttribute(name, value);

    const merged: Attrs = { ...opts, type, value: val, id };
    return `<input${serializeAttributes(merged)}>`;
  }

  text(name: string, value?: unknown, options: Attrs = {}): string {
    return this.input('text', name, value, options);
  }

  hidden(name: string, value?: unknown, options: Attrs = {}): string {
    return this.input('hidden', name, value, options);
  }

  file(name: string, options: Attrs = {}): string {
    return this.input('file', name, null, options);
  }

  submit(value?: unknown, options: Attrs = {}): string {
    return this.input('submit', null, value, options);
  }

  // Form::button($value, $options) — default type="button", value NOT escaped.
  button(value: unknown, options: Attrs = {}): string {
    const opts = { ...options };
    if (!('type' in opts)) opts['type'] = 'button';
    return `<button${serializeAttributes(opts)}>${value ?? ''}</button>`;
  }

  // Form::textarea($name, $value, $options) — order: options..., cols, rows, id.
  textarea(name: string, value?: unknown, options: Attrs = {}): string {
    const opts: Attrs = { ...options };
    if (!('name' in opts)) opts['name'] = name;
    // setTextAreaSize: size -> cols/rows, or append default cols/rows (defaults go last,
    // user-provided cols/rows keep their position).
    if ('size' in opts) {
      const [c, r] = String(opts['size']).split('x');
      opts['cols'] = Number(c);
      opts['rows'] = Number(r);
      delete opts['size'];
    }
    if (!('cols' in opts)) opts['cols'] = 50;
    if (!('rows' in opts)) opts['rows'] = 10;
    opts['id'] = 'id' in opts ? opts['id'] : name;
    const val = this.getValueAttribute(name, value);
    return `<textarea${serializeAttributes(opts)}>${e(String(val ?? ''))}</textarea>`;
  }

  // Form::select($name, $list, $selected, $selectAttributes, $optionsAttributes)
  select(
    name: string,
    list: Record<string, unknown> = {},
    selected?: unknown,
    selectAttributes: Attrs = {},
    optionsAttributes: Record<string, Attrs> = {},
  ): string {
    const sel = this.getValueAttribute(name, selected);
    const attrs: Attrs = { ...selectAttributes };
    attrs['id'] = 'id' in attrs ? attrs['id'] : name;
    if (!('name' in attrs)) attrs['name'] = name;

    const html: string[] = [];
    if ('placeholder' in attrs) {
      const placeholder = attrs['placeholder'] as string;
      delete attrs['placeholder'];
      const isSelected = this.getSelectedValue(null, sel);
      const pAttrs: Attrs = { selected: isSelected, value: '' };
      html.push(`<option${serializeAttributes(pAttrs)}>${e(placeholder)}</option>`);
    }
    for (const [value, display] of Object.entries(list)) {
      const optionAttributes = optionsAttributes[value] ?? {};
      html.push(this.option(String(display), value, sel, optionAttributes));
    }
    return `<select${serializeAttributes(attrs)}>${html.join('')}</select>`;
  }

  // option(): attribute order value, selected, then extras.
  private option(display: string, value: string, selected: unknown, attributes: Attrs = {}): string {
    const isSelected = this.getSelectedValue(value, selected);
    const opts: Attrs = { value, selected: isSelected, ...attributes };
    return `<option${serializeAttributes(opts)}>${e(display)}</option>`;
  }

  private getSelectedValue(value: string | null, selected: unknown): string | null {
    if (Array.isArray(selected)) {
      return in_array(value, selected, true) || in_array(String(value), selected, true) ? 'selected' : null;
    }
    return String(value) == String(selected) ? 'selected' : null;
  }

  // getValueAttribute(): old input > request input > explicit value > model.
  private getValueAttribute(name: string | null, value: unknown): TemplateValue {
    if (name === null) return value as TemplateValue;
    const old = this.ctx.oldInput(name);
    if (old !== null && old !== undefined && name !== '_method') return old;
    if (value === null && value === undefined && this.ctx.errorsAny()) return null;
    const request = this.ctx.requestInput(name);
    if (request !== null && request !== undefined && request !== '') return request;
    if (value !== null && value !== undefined) return value as TemplateValue;
    if (this.boundModel) return this.boundModel[name] ?? null;
    return null;
  }
}

// ---------------------------------------------------------------- render

// Laravel Session::get semantics: non-consuming read. @fastify/flash stores its data
// at session['flash'] ({type: [msgs]}), so a plain read sees it; consuming (redirect
// flows) uses reply.flash() which also clears it.
function sessionGet(req: FastifyRequest, key: string): TemplateValue {
  const data = (req.session as unknown as Record<string, TemplateValue> | undefined) ?? {};
  if (key in data) return data[key];
  const flash = data['flash'];
  if (flash && typeof flash === 'object' && key in (flash as Record<string, TemplateValue>)) {
    return (flash as Record<string, TemplateValue>)[key];
  }
  return null;
}

export interface RenderContext {
  req: FastifyRequest;
  data?: Record<string, unknown>;
  csrfToken: string;
}

// Per-request template context: auth/errors/session/old/form + static globals.
export async function buildContext(req: FastifyRequest, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const auth: Auth = await currentUser(req);
  const sessionData = (req.session as unknown as Record<string, TemplateValue> | undefined) ?? {};
  const flashStore = sessionData['flash'] as Record<string, TemplateValue> | undefined;
  const flashErrors = flashStore?.['errors'];
  const errors = makeMessageBag((flashErrors as Record<string, string[]>) ?? {});
  const oldInput = (key: string): TemplateValue => {
    const old = sessionData['old'];
    return (old as Record<string, TemplateValue> | undefined)?.[key] ?? null;
  };
  const requestInput = (key: string): TemplateValue => {
    const all = { ...((req.query as Record<string, TemplateValue>) ?? {}), ...((req.body as Record<string, TemplateValue>) ?? {}) };
    return all[key] ?? null;
  };
  const token = csrfTokenOf(req);
  const form = new FormBuilder({
    token: () => token,
    oldInput,
    requestInput,
    errorsAny: () => errors.any(),
    currentUrl: () => req.protocol + '://' + req.host + (req.raw.url ?? '').split('?')[0],
    absoluteUrl: (p?: string) => url(p ?? ''),
  });
  return {
    ...data,
    auth,
    errors,
    session: (key: string) => sessionGet(req, key),
    old: (key: string, def = '') => {
      const v = oldInput(key);
      return v === null || v === undefined ? def : v;
    },
    csrf_token: () => token,
    csrf_field: () => `<input type="hidden" name="_token" value="${e(token)}">`,
    hasRole: (roles: string | string[]) => roleCheck(auth, roles),
    form,
    // static PHP-mimicking globals
    e,
    isset,
    phpEmpty,
    is_array,
    count,
    in_array,
    explode,
    implode,
    strtoupper,
    ucfirst,
    round,
    number_format,
    substr,
    json_encode,
    nl2br,
    date,
    env,
    randomOf,
    config,
    trans,
    url,
    asset,
    route,
  };
}

// Session-backed CSRF token: stable per session, never validated (parity: not enforced).
function csrfTokenOf(req: FastifyRequest): string {
  const data = req.session as Record<string, unknown>;
  let token: string | undefined = typeof data['csrf_token'] === 'string' ? data['csrf_token'] : undefined;
  if (!token) {
    token = randomBytes(20).toString('hex');
    data['csrf_token'] = token;
    (req as FastifyRequest & { saveSession?: () => Promise<void> }).saveSession?.();
  }
  return token;
}

// Blade-style view names: 'layout-test' -> layout-test.njk, 'layouts/app' -> layouts/app.njk
function resolveView(name: string): string | null {
  const rel = name.endsWith('.njk') ? name : `${name}.njk`;
  return fs.existsSync(path.join(viewsDir, rel)) ? rel : null;
}

export async function render(req: FastifyRequest, reply: FastifyReply, name: string, data: Record<string, unknown> = {}): Promise<void> {
  const ctx = await buildContext(req, data);
  const rel = resolveView(name);
  if (!rel) throw new Error(`view not found: ${name}`);
  const html = njkEnv.render(rel, ctx);
  reply.type('text/html; charset=UTF-8').send(html);
}

export async function registerViewPlugins(app: FastifyInstance): Promise<void> {
  await app.register(fastifySecureSession, {
    secret: appConfig.APP_KEY,
    salt: 't01_session_salt', // secure-session requires a 16-byte salt
  });
  await app.register(fastifyFlash);
}
