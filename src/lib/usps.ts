// Port of the old app's App\Libraries\Usps (USPS Web Tools RateV4 over HTTP GET).
// Only getRate is ported (the other methods are private curl helpers). It is a read-only call, so DRY_RUN
// does not apply. The old callers are all commented-out/dead code (Runner test block, the route-less
// UspsController and FrayunController's USPS zone lookup), so no live caller exercises it.
//
// The single outbound seam is request(); it returns the response body like curlHttpApiRequest.

import { parseXml } from './ups.js';

type XmlReply = ReturnType<typeof parseXml>;

type Transport = (url: string) => Promise<string>;

// curl: User-Agent usps-php-api-client, GET, follow redirects (max 3), 120s timeout.
// shortcut: fetch follows up to 20 redirects, not 3; USPS Web Tools does not redirect, upgrade if that changes.
const fetchTransport: Transport = async (url) => {
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'usps-php-api-client' },
    signal: AbortSignal.timeout(120_000),
  });
  return res.text();
};

let transport: Transport = fetchTransport;

// Test seam so unit tests never reach USPS.
export function setUspsTransportForTests(fn: Transport | null): void {
  transport = fn ?? fetchTransport;
}

// PHP: urlencode()
const urlencode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');

export async function request(url: string): Promise<string> {
  return transport(url);
}

export class Usps {
  private url = process.env.USPS_URL ?? '';
  private username = process.env.USPS_USERNAME ?? '';

  // Returns the parsed RateV4Response (SimpleXML as a plain object: r.Package.Zone, r.Package.Postage.Rate,
  // r.Package.Error), or false when the body is not XML (simplexml_load_string failure).
  async getRate(
    fromZip: unknown, toZip: unknown, serviceType: unknown, lb: unknown, oz: unknown, length: unknown, width: unknown,
    height: unknown,
  ): Promise<XmlReply | false> {
    const s = serviceType === 'FIRST CLASS' ? 'FIRST CLASS COMMERCIAL' : 'PRIORITY MAIL';
    const firstClassMailType = serviceType === 'FIRST CLASS' ? '<FirstClassMailType>Package Service</FirstClassMailType>' : '';
    // The "XML=" prefix inside the value is in the PHP too, so the query carries XML=XML%3D... (kept).
    const xml =
      `XML=<RateV4Request USERID="${this.username}"><Revision>2</Revision><Package ID="1ST"><Service>${s}</Service>` +
      `${firstClassMailType}<ZipOrigination>${fromZip}</ZipOrigination><ZipDestination>${toZip}</ZipDestination>` +
      `<Pounds>${lb}</Pounds><Ounces>${oz}</Ounces><Container></Container><Width>${width}</Width><Length>${length}</Length>` +
      `<Height>${height}</Height><Girth></Girth><Machinable>false</Machinable></Package></RateV4Request>`;
    const body = await request(`${this.url}?API=RateV4&XML=${urlencode(xml)}`);
    return /<[A-Za-z]/.test(body) ? parseXml(body) : false;
  }
}
