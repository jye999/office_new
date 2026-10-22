// T03: router registration, named routes, _method spoofing, optional params,
// not-found fallback + Laravel 404, and the 5.4 paginate() JSON shape.

import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { afterEach, describe, expect, it } from 'vitest';
import { paginate } from '../src/http.js';
import { any, installRouter, registerFallback, registerRoute, resource, route, routeTable, routeUrl, singular } from '../src/router.js';
import { registerViewPlugins } from '../src/view.js';

const apps: FastifyInstance[] = [];

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } });
  installRouter(app); // before any route registration
  await app.register(fp(formbody)); // fp() = global scope, like server.ts
  await registerViewPlugins(app);
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('route() / any() / resource()', () => {
  it('registers get with role guard: unauthenticated -> /login', async () => {
    const app = await makeApp();
    route(app, {
      verb: 'get',
      path: '/guarded',
      name: 'guarded',
      roles: ['admin'],
      handler: async (_req, reply) => reply.send('ok'),
    });
    const res = await app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:80/login');
    expect(routeTable['guarded']).toBe('/guarded');
  });

  it('optional param {id?} registers both variants', async () => {
    const app = await makeApp();
    route(app, {
      verb: 'get',
      path: '/opt/{id?}',
      handler: (req, reply) => reply.send(`opt:${(req as { params: { id?: string } }).params?.id ?? '-'}`),
    });
    expect((await app.inject({ method: 'GET', url: '/opt' })).body).toBe('opt:-');
    expect((await app.inject({ method: 'GET', url: '/opt/7' })).body).toBe('opt:7');
  });

  it('any() matches GET and POST', async () => {
    const app = await makeApp();
    any(app, { path: '/anyleak', handler: async (_r, reply) => reply.send('any') });
    expect((await app.inject({ method: 'GET', url: '/anyleak' })).body).toBe('any');
    expect((await app.inject({ method: 'POST', url: '/anyleak' })).body).toBe('any');
  });

  it('resource() paths + _method spoofing', async () => {
    const app = await makeApp();
    const h = (name: string) => async (_req: unknown, reply: { send: (s: string) => void }) => reply.send(name);
    resource(app, '/things', {
      index: h('index'),
      create: h('create'),
      store: h('store'),
      show: h('show'),
      edit: h('edit'),
      update: h('update'),
      destroy: h('destroy'),
    });
    expect((await app.inject({ method: 'GET', url: '/things' })).body).toBe('index');
    expect((await app.inject({ method: 'GET', url: '/things/create' })).body).toBe('create');
    expect((await app.inject({ method: 'POST', url: '/things' })).body).toBe('store');
    expect((await app.inject({ method: 'GET', url: '/things/5' })).body).toBe('show');
    expect((await app.inject({ method: 'GET', url: '/things/5/edit' })).body).toBe('edit');
    expect((await app.inject({ method: 'PUT', url: '/things/5' })).body).toBe('update');
    expect((await app.inject({ method: 'PATCH', url: '/things/5' })).body).toBe('update');
    expect((await app.inject({ method: 'DELETE', url: '/things/5' })).body).toBe('destroy');
    // form spoofing
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const put = await app.inject({ method: 'POST', url: '/things/5', headers: form, payload: '_method=PUT' });
    expect(put.body).toBe('update');
    const del = await app.inject({ method: 'POST', url: '/things/5', headers: form, payload: '_method=DELETE' });
    expect(del.body).toBe('destroy');
    // plain POST to a PUT/DELETE-only path -> 405, like Laravel
    const plain = await app.inject({ method: 'POST', url: '/things/5' });
    expect(plain.statusCode).toBe(405);
    // Laravel resource names
    expect(routeTable['things.index']).toBe('/things');
    expect(routeTable['things.show']).toBe('/things/{thing}');
  });

  it('standalone put() route also gets a POST _method shim', async () => {
    const app = await makeApp();
    route(app, { verb: 'put', path: '/x/{id}', handler: async (_r, reply) => reply.send('put') });
    const res = await app.inject({ method: 'POST', url: '/x/9', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '_method=PUT' });
    expect(res.body).toBe('put');
  });

  it('singular() matches the app resource names', () => {
    expect(singular('four')).toBe('four');
    expect(singular('products')).toBe('product');
    expect(singular('categories')).toBe('category');
  });
});

describe('routeUrl()', () => {
  it('fills {x} and :x placeholders; extras become query', () => {
    registerRoute('a.b', '/products/{id}');
    expect(routeUrl('a.b', { id: 5 })).toBe('/products/5');
    expect(routeUrl('a.b', { id: 5, sort: 'a b' })).toBe('/products/5?sort=a+b');
    registerRoute('c.d', '/p/:token');
    expect(routeUrl('c.d', { token: 'zz' })).toBe('/p/zz');
    expect(routeUrl('nope')).toBe('');
  });
});

describe('not-found fallback (T03)', () => {
  it('unmatched path -> Laravel/Symfony 404 page', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/definitely/not/registered' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Whoops, looks like something went wrong.');
    expect(res.body).toContain('404 | Not Found');
  });

  it('catch-all paths -> 404 until T26/T30 register the handler', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/Supplier' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/Orders.5' })).statusCode).toBe(404);
  });

  it('after registerFallback, catch-all dispatches (login guard applies)', async () => {
    const app = await makeApp();
    registerFallback('Supplier', async (_req, reply) => reply.send('supplier-index'));
    const anon = await app.inject({ method: 'GET', url: '/Supplier' });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe('http://localhost:80/login');
  });
});

describe('paginate() — Laravel 5.4 LengthAwarePaginator JSON', () => {
  function fakeQuery(total: number, rows: unknown[]) {
    const countQb = {
      clone: () => countQb,
      select: () => countQb,
      offset: () => countQb,
      limit: () => countQb,
      execute: async () => [{ total }],
    };
    const base = {
      clone: () => base,
      select: () => countQb,
      offset: () => base,
      limit: () => base,
      execute: async () => rows,
    };
    return base;
  }

  it('page 1 of 2: exact 5.4 keys and values', async () => {
    const app = await makeApp();
    const q = fakeQuery(30, [{ n: 1 }, { n: 2 }]);
    app.get('/pag', async (req, reply) => reply.send(await paginate(q, 15, req)));
    const res = await app.inject({ method: 'GET', url: '/pag' });
    const json = res.json();
    expect(Object.keys(json)).toEqual([
      'current_page', 'data', 'from', 'last_page', 'next_page_url', 'path', 'per_page', 'prev_page_url', 'to', 'total',
    ]);
    expect(json['current_page']).toBe(1);
    expect(json['from']).toBe(1);
    expect(json['to']).toBe(15);
    expect(json['last_page']).toBe(2);
    expect(json['total']).toBe(30);
    expect(json['per_page']).toBe(15);
    expect(json['data']).toEqual([{ n: 1 }, { n: 2 }]);
    expect(json['prev_page_url']).toBeNull();
    expect(json['next_page_url']).toBe('http://localhost:80/pag?page=2');
    expect(json['path']).toBe('http://localhost:80/pag');
  });

  it('reads ?page= and nulls next on last page; total=0 keeps the 5.4 negative-from quirk', async () => {
    const app = await makeApp();
    app.get('/pag2', async (req, reply) => reply.send(await paginate(fakeQuery(30, []), 15, req)));
    app.get('/pag3', async (req, reply) => reply.send(await paginate(fakeQuery(0, []), 15, req)));
    const page2 = await app.inject({ method: 'GET', url: '/pag2?page=2' });
    expect(page2.json()['current_page']).toBe(2);
    expect(page2.json()['prev_page_url']).toBe('http://localhost:80/pag2?page=1');
    expect(page2.json()['next_page_url']).toBeNull();
    expect(page2.json()['to']).toBe(30);
    const empty = await app.inject({ method: 'GET', url: '/pag3' });
    expect(empty.json()['from']).toBe(-14);
    expect(empty.json()['to']).toBe(0);
  });
});
