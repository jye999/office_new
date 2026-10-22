#!/usr/bin/env python3
"""Generate plan/tasks/*.md from plan/inventory.json + PHP sources. Re-runnable; overwrites task files."""
import json, os, re

O = os.path.expanduser('~/code/office')
N = os.path.expanduser('~/code/office_new')
inv = json.load(open(f'{N}/plan/inventory.json'))
os.makedirs(f'{N}/plan/tasks', exist_ok=True)

# Routes that must never be hit by parity/manual tests (spend money, write to marketplaces, send email).
DANGER = re.compile(r'buy|Label|Tracking|tracking|Fulfill|Complete|ship|Ship|void|Reload|scanform|ScanForm|upload|Upload|'
                    r'Accept|Reject|send|email|export|Export|refresh|Refresh|import|Import|copy|delete|Delete|destroy|'
                    r'store|update|Update|save|Save|remove|Remove|move|done|assign|priority|made|progress|clear|load|Request|'
                    r'run|exec|Ping|reset', re.S)

# ---------- model -> table map ----------
models = {}
for fn in os.listdir(f'{O}/app/Models'):
    if not fn.endswith('.php'):
        continue
    s = open(f'{O}/app/Models/{fn}', errors='ignore').read()
    name = fn[:-4]
    t = re.search(r"\$table\s*=\s*['\"](\w+)", s)
    c = re.search(r"\$connection\s*=\s*['\"](\w+)", s)
    snake = re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()
    table = t.group(1) if t else (snake if snake.endswith('s') else snake + 's')
    conn = c.group(1) if c else 'mysql'
    models[name] = ('os_' + table if conn == 'mysql' else f'{conn}:{table}', conn)
models['User'] = ('os_users', 'mysql')


def ctrl_src(ctrl):
    c = inv['controllers'].get(ctrl + 'Controller')
    if not c:
        return None, None
    return c, open(f"{O}/{c['file']}", errors='ignore').read().split('\n')


def body(lines, rng):
    return '\n'.join(lines[rng[0] - 1:rng[1]])


def closure(c, lines, actions):
    """actions + private/helper methods they call via $this->x( / self::x( (transitively)."""
    seen, stack = [], list(actions)
    while stack:
        a = stack.pop()
        if a in seen or a not in c['methods']:
            continue
        seen.append(a)
        b = body(lines, c['methods'][a])
        for m in re.findall(r'(?:\$this->|self::|static::)(\w+)\s*\(', b):
            if m in c['methods'] and m not in seen:
                stack.append(m)
    return seen


def views_in(text):
    return sorted(set(re.findall(r"view\(\s*['\"]([\w.\-/]+)", text)) | set(re.findall(r"View::make\(\s*['\"]([\w.\-/]+)", text)))


def view_file(v):
    return f"resources/views/{v.replace('.', '/')}.blade.php"


def view_deps(v, acc=None):
    acc = acc if acc is not None else []
    p = f'{O}/{view_file(v)}'
    if not os.path.exists(p):
        return acc
    s = open(p, errors='ignore').read()
    for d in re.findall(r"@include\(\s*['\"]([\w.\-/]+)", s):
        if d not in acc:
            acc.append(d)
            view_deps(d, acc)
    return acc


def nlines(path):
    p = f'{O}/{path}'
    return sum(1 for _ in open(p, errors='ignore')) if os.path.exists(p) else 0


def module_task(t):
    out = []
    routes = [r for r in inv['routes'] if not r.get('excluded')
              and any(r['controller'] == c and (acts is None or r['action'] in acts or (r['verb'] == 'resource' and 'resource' in acts))
                      for c, acts in t['ctrls'])]
    out.append('## Routes to port\n')
    out.append('| verb | path | name | action | roles/middleware | source line |\n|---|---|---|---|---|---|')
    for r in routes:
        out.append(f"| {r['verb']} | `{r['path']}` | {r['name'] or ''} | {r['action'] or '(resource)'} | {','.join(m for m in r['middleware'] if m not in ('web',))} | {r['file']}:{r['line']} |")
    safe = []
    all_methods, all_views, libs, mods, tables = [], [], set(), set(), set()
    for ctrl, acts in t['ctrls']:
        c, lines = ctrl_src(ctrl)
        if not c:
            continue
        wanted = [r['action'] for r in routes if r['controller'] == ctrl and r['action']]
        if any(r['controller'] == ctrl and r['verb'] == 'resource' for r in routes):
            wanted += [m for m in ('index', 'create', 'store', 'show', 'edit', 'update', 'destroy') if m in c['methods']]
        if acts is None or 'resource' in (acts or []):
            pass
        meths = closure(c, lines, wanted + ['__construct'])
        for m in meths:
            b = body(lines, c['methods'][m])
            all_methods.append((ctrl, c['file'], m, c['methods'][m], m in wanted))
            for v in views_in(b):
                if v not in all_views:
                    all_views.append(v)
            libs |= set(re.findall(r'\b(' + '|'.join(re.escape(x) for x in c['libraries']) + r')\b', b)) if c['libraries'] else set()
            for mdl in re.findall(r'\b([A-Z]\w+)::', b):
                if mdl in models:
                    mods.add(mdl)
            for tb in re.findall(r"DB::(?:connection\(['\"](\w+)['\"]\)->)?table\(\s*['\"](\w+)", b):
                tables.add(('os_' + tb[1]) if not tb[0] or tb[0] == 'mysql' else f'{tb[0]}:{tb[1]}')
        for r in routes:
            if r['controller'] != ctrl or r['verb'] not in ('get', 'any') or '{' in r['path']:
                continue
            a = r['action']
            if a and a in c['methods'] and not DANGER.search(a + r['path']):
                b = body(lines, c['methods'][a])
                if not re.search(r'->(save|update|delete|insert|create)\(|::(create|destroy)\(|Mail::|Storage::put|curl_|Guzzle|new \\?App\\Libraries', b):
                    safe.append(r['path'])
    out.append('\n## PHP source to read (line ranges; ★ = route action, others = helpers it calls)\n')
    for ctrl, f, m, rng, is_action in all_methods:
        out.append(f"- {'★' if is_action else ' '} `{f}:{rng[0]}-{rng[1]}` `{m}()`")
    if all_views:
        out.append('\n## Views to port (Blade → `views/*.njk`, same path)\n')
        incs = []
        for v in all_views:
            out.append(f'- `{view_file(v)}` ({nlines(view_file(v))} lines)')
            for d in view_deps(v):
                if d not in all_views and d not in incs:
                    incs.append(d)
        for d in incs:
            out.append(f'- `{view_file(d)}` ({nlines(view_file(d))} lines, included partial — skip if it already exists in `views/`)')
    if mods or tables:
        out.append('\n## Tables touched (Kysely names)\n')
        for m in sorted(mods):
            out.append(f'- `{models[m][0]}` (model `app/Models/{m}.php` — check `$hidden`, `$appends`, `$casts`, relationships)')
        for tb in sorted(tables):
            out.append(f'- `{tb}` (query builder)')
    if libs:
        out.append('\n## Libraries used\n')
        for lb in sorted(libs):
            out.append(f'- `app/Libraries/{lb}.php` → must already exist as `src/lib/` port (see deps). If a function you need is missing, add it to that lib port following its style.')
    out.append('\n## Safe GET routes for parity (auto-detected — verify; remove any that write or call external APIs)\n')
    out.append('\n'.join(f'- `{p}`' for p in safe) if safe else '- none (verify by code review + manual checklist)')
    return '\n'.join(out), safe


TASKS = json.load(open(f'{N}/plan/tasks.json'))

index = ['# Task index (run in this order; one at a time)\n', '| id | title | deps | phase |', '|---|---|---|---|']
parity_map = {}
for t in TASKS:
    hdr = [f"# {t['id']} — {t['title']}\n",
           f"Phase: {t['phase']}. Depends on: {', '.join(t.get('deps', [])) or 'none'}.\n",
           'Read `plan/CONVENTIONS.md` and `plan/PLAN.md` first. Old app: `~/code/office` (read-only). Work in `~/code/office_new`.\n']
    if t.get('notes'):
        hdr.append('## Instructions\n\n' + t['notes'].strip() + '\n')
    body_md = ''
    if t.get('ctrls'):
        t['ctrls'] = [(c, a) for c, a in t['ctrls']]
        body_md, safe = module_task(t)
        parity_map[t['id']] = safe
    footer = (f"\n## Done when\n\nSee *Definition of done* in `plan/CONVENTIONS.md`. Run `pnpm typecheck && pnpm test` "
              f"{'and `pnpm parity --task ' + t['id'] + '`' if t.get('ctrls') else ''}. Append your `## {t['id']}` entry to `plan/STATUS.md`.\n")
    open(f"{N}/plan/tasks/{t['id']}.md", 'w').write('\n'.join(hdr) + '\n' + body_md + '\n' + footer)
    index.append(f"| [{t['id']}]({t['id']}.md) | {t['title']} | {', '.join(t.get('deps', []))} | {t['phase']} |")
open(f'{N}/plan/tasks/INDEX.md', 'w').write('\n'.join(index) + '\n')
json.dump(parity_map, open(f'{N}/plan/parity-routes.json', 'w'), indent=1)
print(len(TASKS), 'tasks written')
