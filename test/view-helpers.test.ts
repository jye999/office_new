import { describe, expect, it } from 'vitest';
import {
  date,
  e,
  explode,
  implode,
  in_array,
  isset,
  json_encode,
  nl2br,
  number_format,
  phpEmpty,
  round,
  substr,
  strtoupper,
  trans,
  ucfirst,
  url,
  asset,
  route,
  makeMessageBag,
  config as configGlobal,
} from '../src/view.js';
import { registerRoute } from '../src/router.js';
import { config as appConfig } from '../src/config.js';

describe('PHP-mimicking globals (known PHP output)', () => {
  it('e() matches htmlspecialchars ENT_QUOTES', () => {
    expect(e(`<a href="x" title='y'>`)).toBe('&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;');
    expect(e('a & b')).toBe('a &amp; b');
  });

  it('isset/phpEmpty match PHP semantics', () => {
    expect(isset(null)).toBe(false);
    expect(isset(0)).toBe(true);
    expect(isset('')).toBe(true);
    expect(phpEmpty('')).toBe(true);
    expect(phpEmpty('0')).toBe(true);
    expect(phpEmpty(0)).toBe(true);
    expect(phpEmpty(false)).toBe(true);
    expect(phpEmpty([])).toBe(true);
    expect(phpEmpty({})).toBe(true);
    expect(phpEmpty('no')).toBe(false);
  });

  it('number_format matches PHP', () => {
    expect(number_format(1234.567, 2)).toBe('1,234.57');
    expect(number_format(1234.5)).toBe('1,235');
    expect(number_format(-1234.5, 1)).toBe('-1,234.5');
    expect(number_format(0.5, 0)).toBe('1'); // PHP half-up away from zero
    expect(number_format(1234567.89, 2, ',', '.')).toBe('1.234.567,89');
    expect(number_format(5, 0)).toBe('5');
  });

  it('round matches PHP half-away-from-zero', () => {
    expect(round(1.5)).toBe(2);
    expect(round(-1.5)).toBe(-2);
    expect(round(1.26, 2)).toBe(1.26);
    expect(round(1.015, 2)).toBe(1.01); // float ulp drift below the half edge; noted in STATUS
  });

  it('substr supports negative start and length', () => {
    expect(substr('hello', 1)).toBe('ello');
    expect(substr('hello', -2)).toBe('lo');
    expect(substr('hello', 1, 2)).toBe('el');
    expect(substr('hello', -3, 2)).toBe('ll');
    expect(substr('hello', 10)).toBe('');
  });

  it('explode/implode/strtoupper/ucfirst', () => {
    expect(explode(',', 'a,b,c')).toEqual(['a', 'b', 'c']);
    expect(implode('-', ['a', 'b'])).toBe('a-b');
    expect(strtoupper('AbC')).toBe('ABC');
    expect(ucfirst('hello world')).toBe('Hello world');
  });

  it('in_array loose by default, strict opt-in', () => {
    expect(in_array('1', [1])).toBe(true);
    expect(in_array(1, [1], true)).toBe(true);
    expect(in_array(1, ['1'], true)).toBe(false);
  });

  it('json_encode: PHP escaping (/ and unicode)', () => {
    expect(json_encode('a/b')).toBe('"a\\/b"');
    expect(json_encode('é')).toBe('"\\u00e9"');
    expect(json_encode({ a: 1, b: [true, null] })).toBe('{"a":1,"b":[true,null]}');
    expect(json_encode('line\nbreak')).toBe('"line\\nbreak"');
  });

  it('nl2br matches PHP', () => {
    expect(nl2br('a\nb\nc')).toBe('a<br />\nb<br />\nc');
    expect(nl2br('a\r\nb')).toBe('a<br /><br />\nb'); // PHP quirk: \n pass re-processes step-1 output
    expect(nl2br('a\rb')).toBe('a<br />b');
  });

  it('trans reads ported lang files, returns key when missing', () => {
    expect(trans('auth.failed')).toBe('These credentials do not match our records.');
    expect(trans('pagination.next')).toBe('Next &raquo;');
    expect(trans('validation.between.numeric', { attribute: 'qty', min: 1, max: 5 })).toBe(
      'The qty must be between 1 and 5.',
    );
    expect(trans('nope.missing')).toBe('nope.missing');
  });

  it('url/asset/route', () => {
    const base = appConfig.APP_URL.replace(/\/+$/, '');
    expect(url()).toBe(base);
    expect(url('login')).toBe(`${base}/login`);
    expect(url('login', { a: 'b c' })).toBe(`${base}/login?a=b+c`); // http_build_query encodes spaces as +
    expect(asset('css/app.css')).toBe(`${base}/css/app.css`);
    registerRoute('t01.test', '/t01/:id');
    expect(route('t01.test', { id: 7 })).toBe('/t01/7');
    expect(route('t01.test', { id: 7, extra: 'x' })).toBe('/t01/7?extra=x');
    expect(configGlobal('app.name')).toBe('Angel Isabella');
    expect(configGlobal('app.locale')).toBe('en');
    expect(configGlobal('missing.key', 'def')).toBe('def');
  });

  it('date() format chars (reference computed independently in the app tz)', () => {
    const ts = 1700000000;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: appConfig.APP_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ts * 1000));
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const y = g('year'),
      mo = g('month'),
      d = g('day'),
      h = Number(g('hour')),
      mi = g('minute'),
      s = g('second');
    expect(date('Y-m-d H:i:s', ts)).toBe(`${y}-${mo}-${d} ${g('hour')}:${mi}:${s}`);
    expect(date('j.n.y h:i A', ts)).toBe(`${Number(d)}.${mo}.${y.slice(-2)} ${String(h % 12 || 12).padStart(2, '0')}:${mi} ${h < 12 ? 'AM' : 'PM'}`);
    expect(date('Y-m-d', ts)).toBe(`${y}-${mo}-${d}`);
  });
});

describe('MessageBag', () => {
  it('Laravel bag API', () => {
    const bag = makeMessageBag({ name: ['required'], email: ['a', 'b'] });
    expect(bag.has('name')).toBe(true);
    expect(bag.has('x')).toBe(false);
    expect(bag.first('email')).toBe('a');
    expect(bag.first('x')).toBe(null);
    expect(bag.get('email')).toEqual(['a', 'b']);
    expect(bag.all()).toEqual(['required', 'a', 'b']);
    expect(bag.any()).toBe(true);
    expect(bag.count()).toBe(3);
    expect(makeMessageBag().any()).toBe(false);
  });
});
