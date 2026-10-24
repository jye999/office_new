# Page parity tools (use when `pnpm parity` reports a big HTML diff)
Needs old app on :6999 and new app on :7000 (`pnpm start` in background, kill it when done).
1. `URLPATH=unshipped2 bash plan/tools/fetchpair.sh`  — logs into both, saves /tmp/pg6999.html and /tmp/pg7000.html (GET only; never use for mutating routes)
2. `python3 -I plan/tools/pagecmp.py 10` — token-level diff ignoring ports, CSRF tokens and debugbar; prints the first 10 hunks. `hunks 0` = identical.
Fix the templates/services until `hunks 0` for every safe GET page in your task.
