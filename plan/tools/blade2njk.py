#!/usr/bin/env python3
"""Mechanical Blade -> Nunjucks draft converter for the office port.

usage: blade2njk.py <view-name> [PHP_BLOCKS.json]   (e.g. allunshipped)
Reads ~/code/office/resources/views/<view>.blade.php, writes ~/code/office_new/views/<view>.njk.

Handles directives (@extends/@section/@stop/@if/@elseif/@else/@endif/@foreach/@role/@include),
{{ }} / {{{ }}} / {!! !!} expressions (PHP -> Nunjucks incl. ternaries, `.` concat, casts) and the common
`<?php ... ?>` shapes (`echo EXPR;`, `if (COND) echo EXPR;`). Any other <?php block is looked up (whitespace-
collapsed) in the optional JSON map {normalized php: njk replacement}; unknown blocks are left as
`@@PHP[n]@@` and printed so they can be added to the map. Review the output and compare with pagecmp.py.
"""
import json
import os
import re
import sys

OLD = os.path.expanduser('~/code/office/resources/views/')
NEW = os.path.expanduser('~/code/office_new/views/')
STR = re.compile(r"""'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*\"""")


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


def split_top(s, sep_pred):
    """split s at depth-0 positions where sep_pred(s, i) returns the separator length (>0)."""
    parts, depth, last, i = [], 0, 0, 0
    while i < len(s):
        c = s[i]
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif depth == 0:
            n = sep_pred(s, i)
            if n:
                parts.append(s[last:i])
                i += n
                last = i
                continue
        i += 1
    parts.append(s[last:])
    return parts


def conv_expr(e):
    strings = []

    def keep(m):
        strings.append(m.group(0))
        return '\x00%d\x00' % (len(strings) - 1)

    e = STR.sub(keep, e.strip())
    e = e.replace('URL::route(', 'route(').replace('URL::to(', 'url(').replace('Auth::user()', 'auth.user')
    e = e.replace('->', '\x01')
    e = _conv(e)
    e = e.replace('\x01', '.')
    return re.sub(r'\x00(\d+)\x00', lambda m: strings[int(m.group(1))], e)


def _conv(e):
    e = e.strip()
    # ternary at depth 0 (outermost): cond ? a : b
    q = split_top(e, lambda s, i: 1 if s[i] == '?' else 0)
    if len(q) > 1:
        cond = q[0]
        rest = e[len(cond) + 1:]
        # matching ':' for this '?': first depth-0 ':' counting nested '?'
        depth_q, parts, i, last = 0, None, 0, 0
        pd = 0
        for i, c in enumerate(rest):
            if c in '([{':
                pd += 1
            elif c in ')]}':
                pd -= 1
            elif pd == 0 and c == '?':
                depth_q += 1
            elif pd == 0 and c == ':':
                if depth_q == 0:
                    parts = (rest[:i], rest[i + 1:])
                    break
                depth_q -= 1
        if parts:
            return '(%s if %s else %s)' % (_conv(parts[0]), _conv(cond), _conv(parts[1]))
    # logical operators
    for op, rep in (('||', ' or '), ('&&', ' and ')):
        pieces = split_top(e, lambda s, i, op=op: 2 if s.startswith(op, i) else 0)
        if len(pieces) > 1:
            return rep.join(_conv(p) for p in pieces)
    # comparison (lower precedence than `.` and + / -)
    for op in ('===', '!==', '==', '!=', '>=', '<=', '>', '<'):
        def at(s, i, op=op):
            if not s.startswith(op, i):
                return 0
            if op in ('>', '<') and (s[i + 1:i + 2] == '=' or s[i - 1:i] in ('-', '=', '\x01', '<', '>')):
                return 0
            if op in ('==', '!=') and (s[i + len(op):i + len(op) + 1] == '=' or s[i - 1:i] in ('=', '!', '<', '>')):
                return 0
            return len(op)
        pieces = split_top(e, at)
        if len(pieces) == 2:
            left, right = pieces[0].strip(), pieces[1].strip()
            if op in ('==', '!=') and right == 'null':
                return ('' if op == '==' else 'not ') + 'phpNull(%s)' % _conv(left)
            return '%s %s %s' % (_conv(left), op, _conv(right))
    # concatenation
    pieces = split_top(e, lambda s, i: 1 if s[i] == '.' and not (i > 0 and s[i - 1].isdigit() and i + 1 < len(s) and s[i + 1].isdigit()) else 0)
    if len(pieces) > 1:
        return 'cat(%s)' % ', '.join(_conv(p) for p in pieces)
    # additive: PHP + / - are numeric (null -> 0)
    def addsub(s, i):
        if s[i] not in '+-' or s.startswith('->', i):
            return 0
        j = i - 1
        while j >= 0 and s[j] == ' ':
            j -= 1
        if j < 0 or not (s[j].isalnum() or s[j] in ')]_\x00\x01'):
            return 0  # unary sign
        return 1
    ops = []
    pieces = []
    depth, last, i = 0, 0, 0
    while i < len(e):
        c = e[i]
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif depth == 0 and addsub(e, i):
            pieces.append(e[last:i])
            ops.append(e[i])
            last = i + 1
        i += 1
    pieces.append(e[last:])
    if len(pieces) > 1:
        out = 'num(%s)' % _conv(pieces[0])
        for op, pc in zip(ops, pieces[1:]):
            out += ' %s num(%s)' % (op, _conv(pc))
        return out
    # parenthesised group
    if e.startswith('(') and e.endswith(')') and len(split_top(e[1:-1], lambda s, i: 0)) == 1 and _balanced(e[1:-1]):
        return '(%s)' % _conv(e[1:-1])
    if e.startswith('!') and not e.startswith('!='):
        return 'not ' + _conv(e[1:])
    e = re.sub(r'\(\s*int\s*\)\s*(\$?[\w\x01\[\]\x00]+)', r'int(\1)', e)
    e = re.sub(r'\$(\w+)', r'\1', e)
    e = re.sub(r'\bnull\b', 'none', e)
    e = re.sub(r'\bTRUE\b', 'true', e)
    e = e.replace('===', '===').replace('!==', '!==')
    # function args may contain operators: convert inside call parens too
    return _conv_calls(e)


def _balanced(s):
    d = 0
    for c in s:
        if c == '(':
            d += 1
        elif c == ')':
            d -= 1
            if d < 0:
                return False
    return d == 0


def _conv_calls(e):
    """convert arguments of function calls / index brackets that may contain ternaries or concatenation"""
    out, i = '', 0
    while i < len(e):
        c = e[i]
        if c in '([':
            close = ')' if c == '(' else ']'
            depth, j = 1, i + 1
            while j < len(e) and depth:
                if e[j] in '([':
                    depth += 1
                elif e[j] in ')]':
                    depth -= 1
                j += 1
            inner = e[i + 1:j - 1]
            args = split_top(inner, lambda s, k: 1 if s[k] == ',' else 0)
            conv = ', '.join(_conv(a) if a.strip() else a for a in args)
            out += c + conv + close
            i = j
        else:
            out += c
            i += 1
    return out


def balanced_args(s, start):
    """s[start] == '('; return (inner, index after ')')"""
    depth, j = 0, start
    while j < len(s):
        if s[j] == '(':
            depth += 1
        elif s[j] == ')':
            depth -= 1
            if depth == 0:
                return s[start + 1:j], j + 1
        j += 1
    raise ValueError('unbalanced')


def convert_php_block(code, table, unknown):
    code = code.strip()
    key = norm(code)
    for prefix, repl in table.items():  # table keys are (unique) prefixes of the whitespace-collapsed PHP
        if key.startswith(prefix):
            return repl
    m = re.fullmatch(r'echo\s+(.*?);?', key)
    if m and ';' not in m.group(1):
        return '{{ %s | safe }}' % conv_expr(m.group(1))
    m = re.fullmatch(r'if\s*\((.*)\)\s*echo\s+([^;]*);', key)
    if m and 'isset' in m.group(1) and key.count(';') == 1:
        return '{%% if %s %%}{{ %s | safe }}{%% endif %%}' % (conv_expr(m.group(1)), conv_expr(m.group(2)))
    unknown.append(key)
    return '@@PHP[%d]@@' % (len(unknown) - 1)


def convert(src, table):
    unknown = []
    done = []  # converted <?php ?> output is parked behind placeholders so later passes do not re-convert it

    def php(m):
        done.append(convert_php_block(m.group(1), table, unknown))
        return '\x02%d\x02' % (len(done) - 1)

    src = re.sub(r'<\?php(.*?)\?>', php, src, flags=re.S)
    # {!! x !!}, {{{ x }}}, {{ x }}   (Blade's {{{ }}} is escaped in 5.x)
    src = re.sub(r'\{!!(.*?)!!\}', lambda m: '{{ %s | safe }}' % conv_expr(m.group(1)), src, flags=re.S)
    src = re.sub(r'\{\{\{(.*?)\}\}\}', lambda m: '{{ %s }}' % conv_expr(m.group(1)), src, flags=re.S)
    src = re.sub(r'\{\{(?!\s*[%{#])(.*?)\}\}', lambda m: '{{ %s }}' % conv_expr(m.group(1)), src, flags=re.S)
    # directives
    out, i = [], 0
    pat = re.compile(r'@(extends|section|include|foreach|forelse|elseif|if|role|else|endif|endrole|endforeach|endforelse|stop|endsection|show|empty)\b')
    while True:
        m = pat.search(src, i)
        if not m:
            out.append(src[i:])
            break
        out.append(src[i:m.start()])
        name, j = m.group(1), m.end()
        args = ""
        if name in ('extends', 'section', 'include', 'foreach', 'forelse', 'elseif', 'if', 'role'):
            k = j
            while k < len(src) and src[k] in ' \t':
                k += 1
            if k < len(src) and src[k] == '(':
                args, j = balanced_args(src, k)
        if name == 'extends':
            out.append('{%% extends "%s.njk" %%}' % args.strip().strip('\'"').replace('.', '/'))
        elif name == 'section':
            out.append('{%% block %s %%}' % args.strip().strip('\'"').split(',')[0].strip('\'" '))
        elif name == 'include':
            out.append('{%% include "%s.njk" %%}' % args.split(',')[0].strip().strip('\'"').replace('.', '/'))
        elif name in ('foreach', 'forelse'):
            m2 = re.fullmatch(r'\s*(.*?)\s+as\s+(?:\$(\w+)\s*=>\s*)?\$(\w+)\s*', args, flags=re.S)
            assert m2 is not None
            seq, k_, v_ = conv_expr(m2.group(1)), m2.group(2), m2.group(3)
            out.append('{%% for %s%s in %s %%}' % (k_ + ', ' if k_ else '', v_, seq))
        elif name == 'if':
            out.append('{%% if %s %%}' % conv_expr(args))
        elif name == 'elseif':
            out.append('{%% elif %s %%}' % conv_expr(args))
        elif name == 'role':
            out.append('{%% if hasRole(%s) %%}' % conv_expr(args))
        elif name in ('else', 'empty'):
            out.append('{% else %}')
        elif name in ('endif', 'endrole'):
            out.append('{% endif %}')  # Blade compiles both to PHP endif: they are interchangeable
        elif name in ('endforeach', 'endforelse'):
            out.append('{% endfor %}')
        else:  # stop / endsection / show
            out.append('{% endblock %}')
        i = j
    result = re.sub(r'\x02(\d+)\x02', lambda m: done[int(m.group(1))], ''.join(out))
    return result, unknown


def main():
    view = sys.argv[1]
    table = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else {}
    src = open(OLD + view + '.blade.php').read()
    dst, unknown = convert(src, table)
    open(NEW + view + '.njk', 'w').write(dst)
    print('wrote %s.njk; unknown PHP blocks: %d' % (view, len(unknown)))
    for n, u in enumerate(unknown):
        print('  [%d] %s' % (n, u[:300]))


if __name__ == '__main__':
    main()
