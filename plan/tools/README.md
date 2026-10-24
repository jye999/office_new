# Page parity tools (use when `pnpm parity` reports a big HTML diff)
Needs old app on :6999 and new app on :7000 (`pnpm start` in background, kill it when done).
1. `URLPATH=unshipped2 bash plan/tools/fetchpair.sh`  — logs into both, saves /tmp/pg6999.html and /tmp/pg7000.html (GET only; never use for mutating routes)
2. `python3 -I plan/tools/pagecmp.py 10` — token-level diff ignoring ports, CSRF tokens and debugbar; prints the first 10 hunks. `hunks 0` = identical.
Fix the templates/services until `hunks 0` for every safe GET page in your task.

## Blade -> Nunjucks converter
`python3 -I plan/tools/blade2njk.py <view> plan/tools/php_blocks.json` converts `~/code/office/resources/views/<view>.blade.php`
to `views/<view>.njk` (directives, `{{ }}` expressions with PHP loose-null/`+`/`.` semantics, common `<?php ?>` shapes). Unknown
`<?php ?>` blocks are listed; add them (prefix of the whitespace-collapsed PHP -> njk) to `php_blocks.json` and rerun.
Always verify with `pagecmp.py` (and seed temp rows when a store is empty). Needs view globals: phpNull, num, cat, strlen,
array_key_exists, ceil, time, sizeof (src/view.ts).
`phpsort-fuzz.ts` checks src/lib/phpSort.ts against the old app's PHP 7.4 (docker `office`).
