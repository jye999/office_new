// KeywordsController (routes/web.php:156-159, all role:admin,user,remote).
//
// `os_keywords` / `os_keywords_trend` do not exist in the shared DB, so Index,
// AddKeyword (with input) and AddAsin (with input) 500 in the old app; GetRank
// 500s earlier, on the missing `App\Http\Controllers\Client` class (no `use`
// import), before it touches the DB. All reproduced via sendServer500
// (NOTES.md). Raw SQL is used for the keyword tables because they are absent
// from the generated Kysely types.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { db, nowDb, sql } from '../../db.js';
import { input } from '../../http.js';
import { any } from '../../router.js';
import { render, sendServer500 } from '../../view.js';

const MIDDLEWARE = ['web', 'role:admin,user,remote'];

// response()->json(x): JSON content type even for a bare string (the view's
// `if(r=='ok')` check relies on the client parsing it back to the string).
function jsonValue(reply: FastifyReply, value: unknown): void {
  reply.type('application/json; charset=utf-8').send(JSON.stringify(value));
}

export function registerKeywordsRoutes(app: FastifyInstance): void {
  // Index: Keyword::with(['trend' => orderBy created_at desc])->get().
  any(app, {
    path: '/Keywords',
    name: 'Keywords',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      try {
        const kw = await sql`select * from os_keywords`.execute(db);
        const tr = await sql`select * from os_keywords_trend order by created_at desc`.execute(db);
        const byId = new Map<string, { rank: unknown }[]>();
        for (const t of tr.rows as { keywords_id: unknown; rank: unknown }[]) {
          const list = byId.get(String(t.keywords_id)) ?? [];
          list.push(t);
          byId.set(String(t.keywords_id), list);
        }
        // Eloquent serialises every column plus the loaded `trend` relation
        // (created_at desc); the view only reads keyword, asin and trend.
        const keywords = (kw.rows as Record<string, unknown>[]).map((k) => {
          const trend = byId.get(String(k.id)) ?? [];
          const reversed = trend.map((t) => String(t.rank)).reverse(); // array_reverse($points)
          const trendPoints = reversed.join(','); // implode(',', array_reverse($points))
          const last = trend[0] ?? null; // $k->trend->first()
          return { ...k, trendPoints, lastTrendRank: last == null ? '' : String(last.rank) };
        });
        await render(req, reply, 'keywords/index', { keywords });
      } catch {
        await sendServer500(req, reply);
      }
    },
  });

  // AddKeyword: comma list of keywords, insert each not already present.
  any(app, {
    path: '/AddKeywords',
    name: 'AddKeywords',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const raw = input(req, 'keywords');
      if (raw === null) return jsonValue(reply, ''); // ! $request->has('keywords')
      try {
        const ts = nowDb();
        for (const item of String(raw).split(',')) {
          const k = item.trim();
          const { rows } = await sql<{ c: number }>`select count(*) as c from os_keywords where keyword = ${k}`.execute(db);
          if (Number(rows[0]?.c ?? 0) === 0) {
            await sql`insert into os_keywords (keyword, created_at, updated_at) values (${k}, ${ts}, ${ts})`.execute(db);
          }
        }
        jsonValue(reply, 'ok');
      } catch {
        await sendServer500(req, reply);
      }
    },
  });

  // AddAsin: keyword + comma list of asins, insert each (keyword, asin) pair.
  any(app, {
    path: '/AddAsin',
    name: 'AddAsin',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const kw = input(req, 'keyword');
      const asinsRaw = input(req, 'asins');
      if (kw === null || asinsRaw === null) return jsonValue(reply, ''); // ! has('keyword')||has('asins')
      const k = String(kw).trim();
      try {
        const ts = nowDb();
        for (const item of String(asinsRaw).split(',')) {
          const asin = item.trim();
          const existing = await sql`select id from os_keywords where keyword = ${k} and asin = ${asin} limit 1`.execute(db);
          if (existing.rows.length === 0) {
            await sql`insert into os_keywords (keyword, asin, created_at, updated_at) values (${k}, ${asin}, ${ts}, ${ts})`.execute(db);
          }
        }
        jsonValue(reply, 'ok');
      } catch {
        await sendServer500(req, reply);
      }
    },
  });

  // GetRank: `new Client()` resolves to the non-existent App\Http\Controllers\
  // Client (no import) -> fatal 500 before any DB query or Amazon call.
  any(app, {
    path: '/GetRank',
    name: 'GetRank',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      await sendServer500(req, reply);
    },
  });
}
