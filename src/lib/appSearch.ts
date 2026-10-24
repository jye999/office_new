// Port of the old app's App\Libraries\AppSearch (getAmzSearch only method). It has no callers in app/; ported because it is
// a read-only GET. Every outbound call goes through request() so tests can mock it.

export interface AppSearchRequest {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
}

type AppSearchTransport = (req: AppSearchRequest) => Promise<string | false>;

// curl: CONNECTTIMEOUT 5, TIMEOUT 3, SSL verify off (not reproduced: fetch has no verify switch), a failed transfer is `false`.
const fetchTransport: AppSearchTransport = async (req) => {
  const url = new URL(req.url);
  if (url.protocol !== 'https:' || url.hostname !== 'www.amazon.com') throw new Error(`AppSearch: host not allowed: ${url.hostname}`);
  try {
    const res = await fetch(url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(3000) });
    return await res.text();
  } catch {
    return false;
  }
};

let transport: AppSearchTransport = fetchTransport;

// Test seam so unit tests never call amazon.com.
export function setAppSearchTransportForTests(fn: AppSearchTransport | null): void {
  transport = fn ?? fetchTransport;
}

// The single outbound seam.
export function request(req: AppSearchRequest): Promise<string | false> {
  return transport(req);
}

export class AppSearch {
  // $keyword is concatenated unencoded, like the PHP.
  getAmzSearch(keyword: string, page: number = 1): Promise<string | false> {
    let url = `https://www.amazon.com/s/ref=nb_sb_noss_2?url=search-alias%3Daps&field-keywords=${keyword}`;
    if (page > 1) url += `&page=${page}`;
    return request({ method: 'GET', url, headers: { Accept: 'application/json' } });
  }
}
