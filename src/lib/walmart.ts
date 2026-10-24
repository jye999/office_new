// Port of the old app's App\Libraries\Walmart (Walmart Marketplace + Drop Ship Vendor REST/XML API over curl).
// Ported (the methods Runner calls): dsv, getToken (internal), httpPost/httpPostFile/httpDownload (internal),
// getReleasedOrders, getDsvReleasedOrders, getOrder, ackOrder, ackDsvOrder, shipOrder, shipDsvOrder, updateInventory,
// updateDsvInventory, getDsvItems, getItemReport (+ delete_files).
// Skipped (no caller in app/): sign, calculateSignature (RSA signing, only in commented-out code), getMilliseconds,
// getDsvOrder, and the commented-out oldshipOrder. The PHP `print`/`print_r` debug output of every method is not reproduced
// (only Log::info -> console.info is).
//
// Return shapes: PHP returned SimpleXMLElements; here they are the json_decode(json_encode($simplexml)) shape of
// ups.ts parseXml: leaf element -> string, repeated element -> array, namespace prefixes stripped. So
// `$result->meta->totalCount` is `result.meta.totalCount` (a string) and `$result->elements->order` is an object when
// there is one order and an array when there are several (Runner's `totalCount == 1` branch relies on that). When the reply
// has no list the PHP returned the (empty) xpath result: `[]`. Callers test it with empty().
//
// Every outbound call goes through request(). Writes (POST to orders/*/acknowledge|shipping, POST feeds) are logged and
// NOT sent when DRY_RUN=1; the OAuth token POST and all GETs are always sent.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parseXml, type XmlReply } from './ups.js';

export class WalmartError extends Error {}
export class WalmartDryRunError extends Error {}

export interface WalmartRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface WalmartResponse {
  status: number;
  body: Buffer | string;
}

type WalmartTransport = (req: WalmartRequest) => Promise<WalmartResponse>;

const ALLOWED_HOSTS = new Set(['marketplace.walmartapis.com', 'api-gateway.walmart.com']);

const fetchTransport: WalmartTransport = async (req) => {
  const url = new URL(req.url);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) throw new WalmartError(`Walmart: host not allowed: ${url.hostname}`);
  // curl (no FOLLOWLOCATION) does not follow redirects either.
  const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(300_000) });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

let transport: WalmartTransport = fetchTransport;
let pauseMs = 500; // PHP usleep(500000) after every call

// Test seam so unit tests never call walmart.com (and don't sleep).
export function setWalmartTransportForTests(fn: WalmartTransport | null, pause = 500): void {
  transport = fn ?? fetchTransport;
  pauseMs = fn ? 0 : pause;
}

// The single outbound seam.
export function request(req: WalmartRequest): Promise<WalmartResponse> {
  return transport(req);
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const text = (r: WalmartResponse): string => (typeof r.body === 'string' ? r.body : r.body.toString('utf8'));
const correlationId = (): string => createHash('md5').update(randomBytes(8)).digest('hex').slice(0, 7); // substr(md5(rand()), 0, 7)
const storagePath = (rel: string): string => join(process.env.STORAGE_DIR ?? '/home/johnny/code/office/storage', rel);

// ---- XML in (PHP: simplexml_load_string + xpath("//ns3:list") + ->children("ns3", true)) ----

function load(body: string): XmlReply {
  const t = body.trim();
  // simplexml_load_string() returns false on junk and the next `$xml->...` is a fatal Error in PHP.
  if (!t.startsWith('<')) throw new WalmartError('Call to a member function on boolean (unparseable Walmart reply)');
  return parseXml(`<doc>${t}</doc>`); // parseXml drops the root's name; keep it for the //ns3:list lookup
}

// children('ns3', true): the top-level elements of that prefix, prefix and attributes dropped (also in nested levels).
function stripPrefix(node: XmlReply, prefix: string | null): XmlReply {
  if (Array.isArray(node)) return node.map((n) => stripPrefix(n, null));
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '@attributes') continue;
    const m = /^([A-Za-z0-9_]+):(.+)$/.exec(k);
    if (prefix !== null && (!m || m[1] !== prefix)) continue;
    out[m ? m[2] : k] = stripPrefix(v, null);
  }
  return out;
}

// xpath("//ns3:list"): first element named ns3:list anywhere under (or at) the root.
function findList(node: XmlReply, name: string): XmlReply | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  if (!Array.isArray(node) && name in node) return Array.isArray(node[name]) ? node[name][0] : node[name];
  for (const v of Object.values(node)) {
    const hit = findList(v, name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// Shared tail of getReleasedOrders/ackOrder/shipDsvOrder/...: the list's ns3 children, else Log::info + [].
function ordersList(result: string): XmlReply {
  const list = findList(load(result), 'ns3:list');
  if (list !== undefined && Object.keys(list).filter((k) => k !== '@attributes').length > 0) return stripPrefix(list, 'ns3');
  console.info(result);
  return [];
}

// PHP str_getcsv() for one file() line: trailing line break stripped, empty line -> [null].
// shortcut: no escape-char handling outside quotes and no multi-line quoted fields (file() splits on \n first, like PHP).
function strGetCsv(line: string): (string | null)[] {
  const l = line.replace(/\r?\n$/, '');
  if (l === '') return [null];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (quoted) {
      if (ch === '"' && l[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---- zip (PHP ZipArchive::open/extractTo) ----

// shortcut: stored/deflate entries only, no zip64/encryption — what Walmart's item report zip uses.
async function extractZip(zip: Buffer, dir: string): Promise<void> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new WalmartError('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.includes('..')) continue;
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + size);
    const target = join(dir, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, method === 8 ? inflateRawSync(raw) : raw);
  }
}

// ---- the client ----

export interface WalmartInventoryItem {
  sku: string;
  qty: number | string;
}

export interface WalmartShipLine {
  lineNumber: string | number;
  lineQty: string | number;
  tracking: string;
  tracking_date: string;
  code?: string;
}

export class Walmart {
  private apiUrl = 'https://marketplace.walmartapis.com/v3/';
  private clientId = process.env.WALMART_CLIENT_ID ?? '';
  private clientSecret = process.env.WALMART_CLIENT_SECRET ?? '';
  private channel = process.env.WALMART_CHANNEL_TYPE ?? '';
  private serviceName = 'Walmart Marketplace';
  private serviceVersion = '3.0.0';
  private shipNode: string | undefined;
  private accessToken: string | null = null;
  private accessTokenExpire: number | null = null; // epoch ms

  dsv(): void {
    this.apiUrl = 'https://api-gateway.walmart.com/v3/';
    this.channel = process.env.WALMART_DSV_CHANNEL_TYPE ?? '';
    this.serviceName = 'Drop Ship Vendor Services';
    this.serviceVersion = '3.0.0';
    this.shipNode = process.env.WALMART_DSV_SHIPNODE;
    this.accessToken = null;
    this.accessTokenExpire = null;
  }

  private basicAuth(): string {
    return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  // OAuth token (always sent, also under DRY_RUN: it only reads). Reply: <OAuthTokenDTO><accessToken/><expiresIn/>.
  async getToken(): Promise<string> {
    const before = Date.now();
    const res = await request({
      method: 'POST',
      url: this.apiUrl + 'token',
      headers: {
        Authorization: this.basicAuth(),
        Accept: 'application/xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'WM_SVC.NAME': this.serviceName,
        'WM_QOS.CORRELATION_ID': correlationId(),
      },
      body: 'grant_type=client_credentials',
    });
    await sleep(pauseMs);
    const xml = text(res).trim().startsWith('<') ? parseXml(text(res).trim()) : null;
    if (xml === null || typeof xml.accessToken !== 'string') throw new WalmartError('Trying to get property of non-object (Walmart token reply)');
    const token: string = xml.accessToken;
    this.accessToken = token;
    this.accessTokenExpire = before + Number(xml.expiresIn) * 1000;
    return token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/xml',
      'Content-Type': 'application/xml',
      'WM_SVC.NAME': this.serviceName,
      'WM_SVC.VERSION': this.serviceVersion,
      'WM_CONSUMER.CHANNEL.TYPE': this.channel,
      'WM_QOS.CORRELATION_ID': correlationId(),
    };
    if (this.accessToken === null) await this.getToken();
    if (this.accessTokenExpire! < Date.now()) await this.getToken();
    headers.Authorization = this.basicAuth();
    headers['WM_SEC.ACCESS_TOKEN'] = this.accessToken!;
    return headers;
  }

  // POST is a write: logged and not sent under DRY_RUN=1, before any token fetch.
  private dryRun(method: string, url: string, body: string | undefined): void {
    if (method === 'POST' && process.env.DRY_RUN === '1') {
      console.info(`[DRY_RUN] Walmart ${method} ${url} not sent`, body ?? '');
      throw new WalmartDryRunError(`DRY_RUN: Walmart ${method} ${url} not sent`);
    }
  }

  // PHP httpPost($url, $method, $query): body is only sent for POST.
  async httpPost(url: string, method: string, query: string | null = null): Promise<string> {
    const body = method === 'POST' && query != null && query !== '' ? query : undefined;
    this.dryRun(method, url, body);
    const res = await request({ method, url, headers: await this.authHeaders(), body });
    await sleep(pauseMs);
    return text(res);
  }

  // PHP httpPostFile: CURLOPT_POSTFIELDS ['file' => $xml] is a multipart/form-data body (field "file"), but the explicit
  // Content-Type: application/xml header replaces curl's multipart one (so it carries no boundary).
  async httpPostFile(url: string, method: string, xml: string): Promise<string> {
    const boundary = '------------------------' + randomBytes(8).toString('hex');
    const body = method === 'POST' ? `--${boundary}\r\nContent-Disposition: form-data; name="file"\r\n\r\n${xml}\r\n--${boundary}--\r\n` : undefined;
    this.dryRun(method, url, body);
    const res = await request({ method, url, headers: await this.authHeaders(), body });
    await sleep(pauseMs);
    return text(res);
  }

  // PHP httpDownload: reply body goes to storage/app/walmart_items.zip (CURLOPT_FILE, no headers); returns "".
  async httpDownload(url: string, method: string, query: string | null = null): Promise<string> {
    const body = method === 'POST' && query != null && query !== '' ? query : undefined;
    this.dryRun(method, url, body);
    const headers = await this.authHeaders();
    await mkdir(storagePath('app'), { recursive: true });
    const res = await request({ method, url, headers, body });
    await writeFile(storagePath('app/walmart_items.zip'), typeof res.body === 'string' ? Buffer.from(res.body) : res.body);
    return '';
  }

  async getReleasedOrders(startDate: string, orderStatus: string): Promise<XmlReply> {
    const url = this.apiUrl + 'orders?status=' + orderStatus + '&createdStartDate=' + startDate + '&limit=100&productInfo=true';
    return ordersList(await this.httpPost(url, 'GET'));
  }

  async getDsvReleasedOrders(startDate: string, orderStatus: string): Promise<XmlReply> {
    const url = this.apiUrl + 'orders?shipNode=' + this.shipNode + '&status=' + orderStatus + '&createdStartDate=' + startDate + '&limit=100';
    return ordersList(await this.httpPost(url, 'GET'));
  }

  // $xml->children('ns3', true): the order's own fields (purchaseOrderId, orderLines, ...).
  async getOrder(orderNumber: string): Promise<XmlReply> {
    const result = await this.httpPost(this.apiUrl + 'orders/' + orderNumber, 'GET');
    return stripPrefix(Object.values(load(result))[0], 'ns3');
  }

  // The reply has no ns3:list on success, so the result is [] ("empty" = ok to the caller); a list means Walmart errors.
  async ackOrder(purchaseOrderId: string): Promise<XmlReply> {
    return ordersList(await this.httpPost(this.apiUrl + 'orders/' + purchaseOrderId + '/acknowledge', 'POST', 'xmlRequest='));
  }

  async ackDsvOrder(purchaseOrderId: string): Promise<XmlReply> {
    return ordersList(await this.httpPost(this.apiUrl + 'orders/' + purchaseOrderId + '/acknowledge?shipNode=' + this.shipNode, 'POST', 'xmlRequest='));
  }

  // Uploads tracking. `carrier` is accepted and ignored like in PHP (overwritten per line from the tracking number).
  // Returns undefined when the reply is not XML (PHP `return;` after "Failed loading XML") — callers then see "empty" = success.
  async shipOrder(purchaseOrderId: string, oLines: WalmartShipLine[], _carrier: string | null = null): Promise<XmlReply> {
    let carrier: string;
    let xmlToPost = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:orderShipment
    xmlns:ns2="http://walmart.com/mp/v3/orders"
    xmlns:ns3="http://walmart.com/">
    <ns2:orderLines>`;
    for (const ol of oLines) {
      if (ol.tracking.slice(0, 2) === '1Z') carrier = 'USP';
      else if (ol.tracking.length > 12) carrier = 'USPS';
      else carrier = 'FedEx';
      xmlToPost += `<ns2:orderLine>
            <ns2:lineNumber>${ol.lineNumber}</ns2:lineNumber>
            <ns2:orderLineStatuses>
                <ns2:orderLineStatus>
                    <ns2:status>Shipped</ns2:status>
                    <ns2:statusQuantity>
                        <ns2:unitOfMeasurement>Each</ns2:unitOfMeasurement>
                        <ns2:amount>${ol.lineQty}</ns2:amount>
                    </ns2:statusQuantity>
                    <ns2:trackingInfo>
                        <ns2:shipDateTime>${ol.tracking_date}</ns2:shipDateTime>
                        <ns2:carrierName>
                            <ns2:carrier>${carrier}</ns2:carrier>
                        </ns2:carrierName>
                        <ns2:methodCode>Standard</ns2:methodCode>
                        <ns2:trackingNumber>${ol.tracking}</ns2:trackingNumber>
                    </ns2:trackingInfo>
                </ns2:orderLineStatus>
            </ns2:orderLineStatuses>
        </ns2:orderLine>`;
    }
    xmlToPost += '</ns2:orderLines></ns2:orderShipment>';
    const result = await this.httpPost(this.apiUrl + 'orders/' + purchaseOrderId + '/shipping', 'POST', xmlToPost);
    if (!result.trim().startsWith('<')) {
      console.info('Failed loading XML');
      return undefined;
    }
    return ordersList(result);
  }

  async shipDsvOrder(purchaseOrderId: string, oLines: WalmartShipLine[], _carrier: string | null = null): Promise<XmlReply> {
    let carrier: string;
    let trackingUrl = 'http://www.ups.com';
    let xmlToPost = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:orderShipment
    xmlns:ns2="http://walmart.com/mp/v3/orders"
    xmlns:ns3="http://walmart.com/">
    <ns2:orderLines>`;
    for (const ol of oLines) {
      if (ol.tracking.slice(0, 2) === '1Z') {
        carrier = 'USP';
        trackingUrl = 'https://www.ups.com/';
      } else if (ol.tracking.length > 12) {
        carrier = 'USPS';
        trackingUrl = 'https://www.usps.com/';
      } else {
        carrier = 'FedEx';
        trackingUrl = 'https://www.fedex.com/';
      }
      xmlToPost += `<ns2:orderLine>
            <ns2:lineNumber>${ol.lineNumber}</ns2:lineNumber>
            <ns2:orderLineStatuses>
                <ns2:orderLineStatus>
                    <ns2:status>Shipped</ns2:status>
                    <ns2:statusQuantity>
                        <ns2:unitOfMeasurement>Each</ns2:unitOfMeasurement>
                        <ns2:amount>${ol.lineQty}</ns2:amount>
                    </ns2:statusQuantity>
                    <ns2:trackingInfo>
                        <ns2:shipDateTime>${ol.tracking_date}</ns2:shipDateTime>
                        <ns2:carrierName>
                        <ns2:otherCarrier>${carrier}</ns2:otherCarrier>
                        </ns2:carrierName>
                        <ns2:methodCode>Standard</ns2:methodCode>
                        <ns2:carrierMethodCode>${ol.code}</ns2:carrierMethodCode>
                        <ns2:trackingNumber>${ol.tracking}</ns2:trackingNumber>
                        <ns2:trackingURL>${trackingUrl}</ns2:trackingURL>
                    </ns2:trackingInfo>
                </ns2:orderLineStatus>
            </ns2:orderLineStatuses>
        </ns2:orderLine>`;
    }
    xmlToPost += '</ns2:orderLines></ns2:orderShipment>';
    return ordersList(await this.httpPost(this.apiUrl + 'orders/' + purchaseOrderId + '/shipping', 'POST', xmlToPost));
  }

  private inventoryXml(items: WalmartInventoryItem[]): string {
    let xml = `<?xml version="1.0" encoding="UTF-8" ?>
        <InventoryFeed xmlns="http://walmart.com/">
        <InventoryHeader>
        <version>1.4</version>
        </InventoryHeader>`;
    for (const i of items) {
      xml += `<inventory>
            <sku>${i.sku}</sku>
            <availabilityCode>AC</availabilityCode>
            <quantity>
            <unit>EACH</unit>
            <amount>${i.qty}</amount>
            </quantity>
            <fulfillmentLagTime>1</fulfillmentLagTime>
        </inventory>`;
    }
    return xml + '</InventoryFeed>';
  }

  // Overwrites stock levels on Walmart. PHP printed the parsed reply and returned nothing.
  async updateInventory(itemsToUpdate: WalmartInventoryItem[]): Promise<void> {
    const result = await this.httpPostFile(this.apiUrl + 'feeds?feedType=inventory', 'POST', this.inventoryXml(itemsToUpdate));
    console.info(result.trim());
  }

  async updateDsvInventory(itemsToUpdate: WalmartInventoryItem[]): Promise<void> {
    const result = await this.httpPostFile(this.apiUrl + 'feeds?feedType=inventory&shipNode=' + this.shipNode, 'POST', this.inventoryXml(itemsToUpdate));
    console.info(result.trim());
  }

  // PHP quirk kept: delete_files(storage/app/walmart) has no trailing slash, so glob('<target>*') also matches the
  // sibling storage/app/walmart_items.zip (and any other walmart* entry in storage/app).
  async delete_files(target: string): Promise<void> {
    const st = await stat(target).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      const slash = target.lastIndexOf('/');
      const parent = target.slice(0, slash + 1);
      const prefix = target.slice(slash + 1);
      const names = (await readdir(parent)).filter((n) => n.startsWith(prefix) && !n.startsWith('.')).sort();
      for (const n of names) {
        const full = parent + n;
        await this.delete_files((await stat(full)).isDirectory() ? full + '/' : full);
      }
      if (await stat(target).catch(() => null)) await rm(target, { recursive: true });
    } else if (st.isFile()) {
      await unlink(target);
    }
  }

  // DSV items: <ns2:ItemResponses> children (totalItems, ItemResponse[]) or [].
  async getDsvItems(): Promise<XmlReply> {
    const result = await this.httpPost(this.apiUrl + 'items', 'GET');
    const nodes = findList(load(result), 'ns2:ItemResponses');
    if (nodes !== undefined && Object.keys(nodes).filter((k) => k !== '@attributes').length > 0) return stripPrefix(nodes, 'ns2');
    console.info(result);
    return [];
  }

  // Downloads the item report zip and returns the rows (arrays of fields, header row included) of the first .csv in it, else [].
  async getItemReport(): Promise<(string | null)[][]> {
    const downloadTo = storagePath('app/walmart_items.zip');
    const zipTo = storagePath('app/walmart');
    await this.delete_files(zipTo);
    await this.httpDownload(this.apiUrl + 'getReport?type=item', 'GET');
    let zip: Buffer;
    try {
      zip = await readFile(downloadTo);
      await extractZip(zip, zipTo);
    } catch {
      return []; // ZipArchive::open() !== true
    }
    for (const f of (await readdir(zipTo)).sort()) {
      if (f.endsWith('.csv')) {
        const lines = (await readFile(join(zipTo, f), 'utf8')).match(/[^\n]*\n|[^\n]+$/g) ?? [];
        return lines.map(strGetCsv);
      }
    }
    return [];
  }
}
