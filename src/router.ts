// T01 stub — T03 owns the real router. Kept minimal and backward compatible:
// register named routes as they are ported; `routeUrl` resolves them Laravel-style.

// name -> path template, e.g. 'products.show' -> '/products/:id'
export const routeTable: Record<string, string> = {};

export function registerRoute(name: string, path: string): void {
  routeTable[name] = path;
}

export function isRegisteredRoute(name: string): name is string {
  return name in routeTable;
}

function escapeUri(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

// Laravel `route()`: fill `:param` segments from params in registration order;
// remaining params become a `?a=b&c=d` query string. Unknown name -> empty string
// (Laravel throws RouteNotFoundException; views only reference real routes).
export function routeUrl(name: string, params?: Record<string, unknown> | unknown[]): string {
  const path = routeTable[name];
  if (path === undefined) return '';
  let url = path;
  const rest: Record<string, unknown> = Array.isArray(params)
    ? Object.fromEntries(params.map((v, i) => [`arg${i}`, v]))
    : { ...(params ?? {}) };
  url = url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key: string) => {
    const v = rest[key];
    delete rest[key];
    if (v === undefined || v === null) return '';
    return escapeUri(String(v));
  });
  const query = Object.entries(rest)
    .map(([k, v]) => `${escapeUri(k)}=${escapeUri(String(v))}`)
    .join('&');
  return query ? `${url}?${query}` : url;
}
