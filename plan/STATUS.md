# Status

One entry per task: `## <ID> — done|partial|blocked`, files, verified, not verified, manual checklist.

## T00 — done
Worker (Qwen) timed out at 30 min while running its final verification; finished and verified by Opus.
- Files: package.json, tsconfig.json, .env.example (.env gitignored), src/config.ts (zod env), src/db.ts (db + hwc Kysely, dateStrings, nowDb), src/db/office.d.ts + hwc.d.ts (kysely-codegen), src/server.ts, test/nowDb.test.ts.
- Fixed: /__health used `selectNoFrom([sql...])` (TS2769) → `sql\`select 1 as one\`.execute(db)`.
- Verified: `pnpm typecheck` OK; `pnpm test` 2/2 pass; server on :7000 → `/__health` = {"ok":true,"db":1}; `/favicon.ico` 200; `/js/app.js` 200.
- Not verified: nothing outstanding for T00.
