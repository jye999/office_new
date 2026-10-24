// PHP SimpleXMLElement semantics over the json_decode(json_encode($simplexml)) shape that lib/ups.ts parseXml()
// (and lib/ebay.ts) return: repeated elements -> arrays, a single child -> the bare value, text-only -> string,
// empty element -> {}, attributes -> '@attributes', text next to attributes -> key '0'.
// Verified against php:7.4-cli (test/simplexml.test.ts goldens).

export type Sx = string | Sx[] | { [k: string]: Sx } | undefined;

// $node->A->B->C : a missing step yields an empty element (no error), modelled as undefined.
export function sxGet(node: Sx, ...names: string[]): Sx {
  let cur: Sx = node;
  for (const n of names) {
    if (cur === undefined || typeof cur === 'string') return undefined;
    // `$node->A` on a list means the first element
    const base: Sx = Array.isArray(cur) ? cur[0] : cur;
    if (base === undefined || typeof base === 'string') return undefined;
    cur = (base as { [k: string]: Sx })[n];
  }
  return cur;
}

// `foreach ($node->A as $x)`: every same-named sibling.
export function sxList(node: Sx): Sx[] {
  return node === undefined ? [] : Array.isArray(node) ? node : [node];
}

// `(string)$node`: element text; elements with children have none.
export function sxText(node: Sx): string {
  const n = Array.isArray(node) ? node[0] : node;
  if (typeof n === 'string') return n;
  const o = n as { [k: string]: Sx } | undefined;
  if (o && typeof o === 'object' && typeof o['0'] === 'string') return o['0'];
  return '';
}

// `isset($node->A)` : the element exists.
export const sxIsset = (node: Sx): boolean => node !== undefined;

// `(bool)$node` / `if ($node)`: has children, attributes or text.
export function sxBool(node: Sx): boolean {
  const n = Array.isArray(node) ? node[0] : node;
  if (n === undefined) return false;
  if (typeof n === 'string') return n !== '' && n !== '0';
  return Object.keys(n).length > 0;
}

// sizeof($node->A): number of same-named siblings.
export const sxCount = (node: Sx): number => sxList(node).length;

// Text-with-attributes elements encode/print as just their text.
function plain(node: Sx): Sx {
  if (Array.isArray(node)) return node.map(plain);
  if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    if (typeof node['0'] === 'string' && keys.every((k) => k === '0' || k === '@attributes')) return node['0'];
    return Object.fromEntries(keys.map((k) => [k, k === '@attributes' ? node[k] : plain(node[k])]));
  }
  return node;
}

const sp = (n: number) => ' '.repeat(n);
function pr(v: Sx, ind: number, head: string): string {
  if (typeof v === 'string') return v;
  const entries: Array<[string, Sx, string]> = Array.isArray(v)
    ? v.map((x, i): [string, Sx, string] => [String(i), x, 'SimpleXMLElement Object'])
    : Object.entries(v ?? {}).map(([k, x]): [string, Sx, string] => [k, x, k === '@attributes' ? 'Array' : Array.isArray(x) ? 'Array' : 'SimpleXMLElement Object']);
  const h = Array.isArray(v) ? 'Array' : head;
  let out = `${h}\n${sp(ind)}(\n`;
  for (const [k, x, hd] of entries) out += `${sp(ind + 4)}[${k}] => ${pr(x, ind + 8, hd)}\n`;
  return `${out}${sp(ind)})\n`;
}

// print_r($simpleXmlElement)
export function sxPrintR(node: Sx): string {
  return pr(plain(node), 0, 'SimpleXMLElement Object');
}

// json_encode($simpleXmlElement) input shape (text-with-attributes collapsed to the text)
export const sxJsonValue = (node: Sx): Sx => plain(node);

// PHP loose `==` between two strings: numeric strings compare as numbers.
export function phpStrEq(a: string, b: string): boolean {
  const num = (s: string) => /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);
  return num(a) && num(b) ? Number(a) === Number(b) : a === b;
}
