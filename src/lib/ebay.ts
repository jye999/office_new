// Port of the old app's App\Libraries\eBay::getMessage() (GetMyMessages, a
// read-only inbox call). The old class has many other methods (buy/revise/
// complete-sale); only what this app's routed code calls is ported.
//
// Response shape note (plan/NOTES.md): the old code consumes the XML through
// SimpleXML, whose `->Message` returns only the FIRST <Message> element and
// foreach iterates its children. Callers port that quirk; this module only
// parses.

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

function xmlEsc(v: string): string {
  return v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

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
  const e = (k: string) => process.env[k] ?? '';
  let xml: string;
  try {
    const res = await fetch(e('EBAY_SERVERURL'), {
      method: 'POST',
      body: `<?xml version="1.0" encoding="utf-8" ?><GetMyMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
        `<RequesterCredentials><eBayAuthToken>${xmlEsc(e('EBAY_TOKEN'))}</eBayAuthToken></RequesterCredentials>` +
        `<FolderID>${xmlEsc(call.folderId)}</FolderID>` +
        (call.msgIds.length > 0 ? `<MessageIDs>${call.msgIds.map((id) => `<MessageID>${xmlEsc(id)}</MessageID>`).join('')}</MessageIDs>` : '') +
        ` <DetailLevel>${xmlEsc(call.detail)}</DetailLevel>` +
        `<Version>${xmlEsc(e('EBAY_COMPATLEVEL'))}</Version></GetMyMessagesRequest>`,
      headers: {
        'X-EBAY-API-COMPATIBILITY-LEVEL': e('EBAY_COMPATLEVEL'),
        'X-EBAY-API-DEV-NAME': e('EBAY_DEVID'),
        'X-EBAY-API-APP-NAME': e('EBAY_APPID'),
        'X-EBAY-API-CERT-NAME': e('EBAY_CERTID'),
        'X-EBAY-API-CALL-NAME': 'GetMyMessages',
        'X-EBAY-API-SITEID': e('EBAY_SITEID'),
      },
    });
    xml = await res.text();
  } catch {
    xml = '';
  }
  // Old app: stristr(HTTP 404) || empty -> echo "oops"; die('<P>Error sending request').
  if (/http 404/i.test(xml) || xml === '') throw new Error('oops<P>Error sending request');
  return parseGetMyMessages(xml);
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
