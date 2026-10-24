// Port of the old app's App\Libraries\eBay (eBay Trading API, XML over HTTPS POST to
// EBAY_SERVERURL / RAYSTORE_SERVERURL). T13 consumes getMessage() through the
// ebayGetMyMessages() wrapper below; L05 added the rest of the live methods.
//
// Every outbound call goes through request() (mockable via setEbayTransportForTests).
// completeSales (CompleteSale: uploads tracking) and reviseItemDescription (ReviseItem:
// rewrites a listing) are logged and NOT sent when DRY_RUN=1.
//
// Skipped (no live caller in ~/code/office/app): awaitingShipment, getOrderTransactions,
// awaitingShipmentTest, completeSalesTest/buildEbayHeadersTest/sendHttpRequestTest (hardcoded
// sandbox creds). The PHP echo/print_r debug output (getActiveListing, awaitingShipment2,
// getOrders, "oops") is not reproduced except the "oops" error message.
//
// Return shape of the XML methods: the SimpleXML reply as parsed by parseXml() in ups.ts
// (json_encode(SimpleXMLElement) shape: repeated elements -> arrays, a single one -> the bare
// value, attribute+text -> {'@attributes', 0: text}). Use xmlList()/xmlText() to read it the way
// SimpleXML foreach / (string) casts do.
//
// T13 note:
// Response shape note (plan/NOTES.md): the old code consumes the XML through
// SimpleXML, whose `->Message` returns only the FIRST <Message> element and
// foreach iterates its children. Callers port that quirk; this module only
// parses.

import { date } from '../view.js';
import { parseXml, type XmlReply } from './ups.js';

export interface EbayMessage {
  [field: string]: string | null;
}

export interface EbayGetMyMessagesResponse {
  // null when the response has no <Messages> element at all.
  messages: EbayMessage[] | null;
  ack: string;
}

export interface EbayCall {
  detail: string;
  msgIds: string[];
  folderId: string;
}

type EbayImpl = (call: EbayCall) => Promise<EbayGetMyMessagesResponse>;

// shortcut: hand-rolled parser for eBay's GetMyMessagesResponse (predictable,
// flat XML); upgrade to a real XML parser if other eBay calls are ported.
function parseGetMyMessages(xml: string): EbayGetMyMessagesResponse {
  const ack = /<Ack>([^<]*)<\/Ack>/.exec(xml)?.[1] ?? '';
  if (!/<Messages[\s>]/.test(xml)) return { ack, messages: null };
  const messages: EbayMessage[] = [];
  let m: RegExpExecArray | null;
  const re = /<Message>([\s\S]*?)<\/Message>/g;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const msg: EbayMessage = {};
    const tre = /<([A-Za-z]+)>([^<]*)</g;
    let tm: RegExpExecArray | null;
    while ((tm = tre.exec(body)) !== null) msg[tm[1]] = tm[2];
    messages.push(msg);
  }
  return { ack, messages };
}

async function ebayGetMyMessagesHttp(call: EbayCall): Promise<EbayGetMyMessagesResponse> {
  return parseGetMyMessages(await new Ebay().getMessageXml(call.detail, call.msgIds, call.folderId));
}

let impl: EbayImpl = ebayGetMyMessagesHttp;

// Test seam so unit tests never call api.ebay.com.
export function setEbayGetMyMessagesForTests(fn: EbayImpl | null): void {
  impl = fn ?? ebayGetMyMessagesHttp;
}

// eBay::getMessage($detail = 'ReturnHeaders', $msgIds = array(), $folderId = '0').
export async function ebayGetMyMessages(detail: string, msgIds: string[] = [], folderId = '0'): Promise<EbayGetMyMessagesResponse> {
  return impl({ detail, msgIds, folderId });
}

// ---- eBay.php (Trading API) ----

export class EbayError extends Error {}

export interface EbayRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

type EbayTransport = (req: EbayRequest) => Promise<string>;

// curl_exec(): the reply text, or false (-> '') when the connection failed.
// shortcut: no CURLOPT_SSL_VERIFYPEER=0 equivalent; fetch always verifies the certificate.
const fetchTransport: EbayTransport = async (req) => {
  try {
    const { protocol, hostname } = new URL(req.url);
    if (protocol !== 'https:' || !(hostname === 'ebay.com' || hostname.endsWith('.ebay.com'))) return '';
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    return await res.text();
  } catch {
    return '';
  }
};

let transport: EbayTransport = fetchTransport;

// Test seam so unit tests never call api.ebay.com.
export function setEbayTransportForTests(fn: EbayTransport | null): void {
  transport = fn ?? fetchTransport;
}

// sendHttpRequest(): the single outbound seam for the Trading API.
export function request(req: EbayRequest): Promise<string> {
  return transport(req);
}

export const WRITE_VERBS = new Set(['CompleteSale', 'ReviseItem']);

// SimpleXML `foreach` over a repeated-or-single child.
export const xmlList = (v: XmlReply): XmlReply[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// SimpleXML `(string)$node`.
export const xmlText = (v: XmlReply): string => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v[0] === 'string' ? v[0] : '');

// config('app.<ebayAppName>.<key>'): 'ebay' -> EBAY_*, 'raystore' -> RAYSTORE_*.
const CONFIG_ENV_SUFFIX = {
  token: 'TOKEN',
  compatLevel: 'COMPATLEVEL',
  devID: 'DEVID',
  appID: 'APPID',
  certID: 'CERTID',
  siteID: 'SITEID',
  serverUrl: 'SERVERURL',
} as const;

// PHP string concatenation of an arbitrary value (null -> '').
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export class Ebay {
  private ebayAppName = 'ebay';

  constructor(ebayAppName = 'ebay') {
    if (ebayAppName !== '') this.ebayAppName = ebayAppName;
  }

  private config(key: keyof typeof CONFIG_ENV_SUFFIX): string {
    return process.env[`${this.ebayAppName.toUpperCase()}_${CONFIG_ENV_SUFFIX[key]}`] ?? '';
  }

  // The PHP concatenates values into the XML without escaping; so does this.
  private requestBody(verb: string, inner: string): string {
    return '<?xml version="1.0" encoding="utf-8" ?>' +
      `<${verb}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
      `<RequesterCredentials><eBayAuthToken>${this.config('token')}</eBayAuthToken></RequesterCredentials>` +
      inner +
      `<Version>${this.config('compatLevel')}</Version></${verb}Request>`;
  }

  // buildEbayHeaders() + sendHttpRequest() + the 'HTTP 404' / empty-reply die().
  private async sendXml(verb: string, inner: string): Promise<string> {
    const body = this.requestBody(verb, inner);
    if (WRITE_VERBS.has(verb) && process.env.DRY_RUN === '1') {
      console.info(`[DRY_RUN] eBay ${verb} not sent`, body);
      throw new EbayError(`DRY_RUN: eBay ${verb} not sent`);
    }
    const responseXml = await request({
      url: this.config('serverUrl'),
      headers: {
        'X-EBAY-API-COMPATIBILITY-LEVEL': this.config('compatLevel'),
        'X-EBAY-API-DEV-NAME': this.config('devID'),
        'X-EBAY-API-APP-NAME': this.config('appID'),
        'X-EBAY-API-CERT-NAME': this.config('certID'),
        'X-EBAY-API-CALL-NAME': verb,
        'X-EBAY-API-SITEID': this.config('siteID'),
      },
      body,
    });
    if (/http 404/i.test(responseXml) || responseXml === '') throw new EbayError('oops<P>Error sending request');
    return responseXml;
  }

  private async sendParsed(verb: string, inner: string): Promise<XmlReply> {
    return parseXml(await this.sendXml(verb, inner));
  }

  awaitingShipment2(pageNumber: number | string): Promise<XmlReply> {
    return this.sendParsed(
      'GetSellingManagerSoldListings',
      '<Filter>PaidNotShipped</Filter><Sort>SaleDate</Sort><SortOrder>Descending</SortOrder>' +
        `<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination>`,
    );
  }

  getActiveListing(pageNumber: number | string): Promise<XmlReply> {
    return this.sendParsed(
      'GetMyeBaySelling',
      '<ActiveList><Include>true</Include><Sort>TimeLeft</Sort>' +
        `<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination></ActiveList>`,
    );
  }

  getSaleRecordDetail(transactionId: unknown, itemId: unknown): Promise<XmlReply> {
    return this.sendParsed('GetSellingManagerSaleRecord', `<ItemID>${s(itemId)}</ItemID><TransactionID>${s(transactionId)}</TransactionID>`);
  }

  // The raw reply text, for ebayGetMyMessages() (T13's own message parser).
  getMessageXml(detail = 'ReturnHeaders', msgIds: string[] = [], folderId = '0'): Promise<string> {
    const ids = msgIds.length > 0 ? `<MessageIDs>${msgIds.map((m) => `<MessageID>${m}</MessageID>`).join('')}</MessageIDs>` : '';
    return this.sendXml('GetMyMessages', `<FolderID>${folderId}</FolderID>${ids} <DetailLevel>${detail}</DetailLevel>`);
  }

  async getMessage(detail = 'ReturnHeaders', msgIds: string[] = [], folderId = '0'): Promise<XmlReply> {
    return parseXml(await this.getMessageXml(detail, msgIds, folderId));
  }

  getItem(itemId: unknown): Promise<XmlReply> {
    return this.sendParsed('GetItem', `<ItemID>${s(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel>`);
  }

  reviseItemDescription(itemId: unknown, description: unknown): Promise<XmlReply> {
    return this.sendParsed(
      'ReviseItem',
      `<Item><ItemID>${s(itemId)}</ItemID><Description><![CDATA[${s(description)}]]></Description><DescriptionReviseMode>Replace</DescriptionReviseMode></Item>`,
    );
  }

  getOrders(page: number | string): Promise<XmlReply> {
    const now = Math.floor(Date.now() / 1000);
    // Local wall-clock time labelled 'Z', as the PHP does.
    return this.sendParsed(
      'GetOrders',
      `<CreateTimeFrom>${date('Y-m-d\\TH:i:s', now - 90 * 86400)}.000Z</CreateTimeFrom><CreateTimeTo>${date('Y-m-d\\TH:i:s', now)}.000Z</CreateTimeTo>` +
        `<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination><OrderStatus>All</OrderStatus><DetailLevel>ReturnAll</DetailLevel>`,
    );
  }

  getOrder(orderId: unknown): Promise<XmlReply> {
    return this.sendParsed('GetOrders', `<OrderIDArray><OrderID>${s(orderId)}</OrderID></OrderIDArray><DetailLevel>ReturnAll</DetailLevel>`);
  }

  completeSales(itemId: unknown, transactionId: unknown, tracking: unknown): Promise<XmlReply> {
    const t = s(tracking);
    const carrier = t.startsWith('Z') ? 'USP' : t.length > 12 ? 'USPS' : 'Fedex';
    return this.sendParsed(
      'CompleteSale',
      `<ItemID>${s(itemId)}</ItemID><Shipment><ShipmentTrackingDetails><ShipmentTrackingNumber>${t}</ShipmentTrackingNumber>` +
        `<ShippingCarrierUsed>${carrier}</ShippingCarrierUsed></ShipmentTrackingDetails></Shipment><Shipped>true</Shipped><TransactionID>${s(transactionId)}</TransactionID>`,
    );
  }
}
