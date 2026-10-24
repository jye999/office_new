// Port of the old app's App\Libraries\UpsClient, including the gabrielbull/ups-api calls it makes
// (legacy UPS XML-over-HTTPS: AccessRequest + <Request> posted to onlinetools.ups.com/ups.app/xml/*).
// Only methods that controllers call are ported: getRate, validateAddress, getLabel, deleteShipment.
// Skipped: trackShipment (no caller).
//
// Every outbound call goes through request(). Write endpoints (see WRITE_ENDPOINTS) are
// logged and NOT sent when DRY_RUN=1.

import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { disk } from '../storage.js';

// Mirrors the library's Ups\Exception\* (Request/InvalidResponse): message is 'Failure: ...'.
export class UpsError extends Error {}

export const WRITE_ENDPOINTS = new Set(['/ShipConfirm', '/ShipAccept', '/Void']);

const PRODUCTION_BASE_URL = 'https://onlinetools.ups.com/ups.app/xml';
const INTEGRATION_BASE_URL = 'https://wwwcie.ups.com/ups.app/xml';

const SERVICE_NAMES: Record<string, string> = {
  '01': 'UPS Next Day Air',
  '02': 'UPS Second Day Air',
  '03': 'UPS Ground',
  '07': 'UPS Worldwide Express',
  '08': 'UPS Worldwide Expedited',
  '11': 'UPS Standard',
  '12': 'UPS Three-Day Select',
  '13': 'Next Day Air Saver',
  '14': 'UPS Next Day Air Early AM',
  '54': 'UPS Worldwide Express Plus',
  '59': 'UPS Second Day Air AM',
  '65': 'UPS Saver',
  '70': 'UPS Access Point Economy',
  '93': 'UPS Sure Post',
};

// ---- XML out (DOMDocument with formatOutput, as the library builds it) ----

interface XmlNode {
  name: string;
  attrs?: Record<string, string>;
  text: string;
  children: XmlNode[];
}

// el('A', 'text') | el('A', [child, ...]) | el('A') -> <A/>. Falsy entries in a child list are dropped.
function el(name: string, content?: unknown, attrs?: Record<string, string>): XmlNode {
  if (Array.isArray(content)) {
    return { name, attrs, text: '', children: content.filter((c): c is XmlNode => Boolean(c)) };
  }
  return { name, attrs, text: content === null || content === undefined ? '' : String(content), children: [] };
}

const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, '&quot;');

function serialize(node: XmlNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  const attrs = Object.entries(node.attrs ?? {}).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  if (node.children.length) {
    const inner = node.children.map((c) => serialize(c, depth + 1)).join('');
    return `${pad}<${node.name}${attrs}>\n${inner}${pad}</${node.name}>\n`;
  }
  if (node.text === '') return `${pad}<${node.name}${attrs}/>\n`;
  return `${pad}<${node.name}${attrs}>${escapeText(node.text)}</${node.name}>\n`;
}

const document = (root: XmlNode): string => `<?xml version="1.0"?>\n${serialize(root)}`;

// ---- XML in: json_decode(json_encode(SimpleXMLElement)) ----

// Dynamic by nature: elements are strings, objects or (when repeated) arrays, exactly like PHP's stdClass.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type XmlReply = any;

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]!;
  });
}

// shortcut: a regex tokenizer for UPS's flat machine-generated replies (no DOCTYPE/namespaces), upgrade if a reply ever needs them.
export function parseXml(xml: string): XmlReply {
  type Frame = { name: string; attrs: Record<string, string>; kids: [string, any][]; text: string };
  const root: Frame = { name: '', attrs: {}, kids: [], text: '' };
  const stack: Frame[] = [root];
  const finish = (f: Frame): any => {
    const out: XmlReply = {};
    if (Object.keys(f.attrs).length) out['@attributes'] = f.attrs;
    for (const [k, v] of f.kids) {
      if (!(k in out)) out[k] = v;
      else if (Array.isArray(out[k])) out[k].push(v);
      else out[k] = [out[k], v];
    }
    if (f.kids.length === 0) {
      if (f.text !== '') return Object.keys(out).length ? { ...out, 0: f.text } : f.text;
      return out; // empty element -> {}
    }
    return out;
  };
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
    else if (m[2] !== undefined) {
      const f = stack.pop()!;
      stack[stack.length - 1].kids.push([f.name, finish(f)]);
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
      const f: Frame = { name: m[3], attrs, kids: [], text: '' };
      if (m[5]) top.kids.push([f.name, finish(f)]);
      else stack.push(f);
    }
  }
  const [name, value] = root.kids[0] ?? ['', {}];
  void name;
  return value;
}

// SimpleXML `(string)$node` / "first of a repeated node"
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const first = (v: any): any => (Array.isArray(v) ? v[0] : v);

// ---- outbound ----

// The single outbound seam: posts AccessRequest + request XML and returns the parsed reply root
// (json_encode(SimpleXML) shape, Response element included). Throws UpsError like the library's Request.
export async function request(accessKey: string, userId: string, password: string, useIntegration: boolean, endpoint: string, requestXml: string): Promise<XmlReply> {
  const url = (useIntegration ? INTEGRATION_BASE_URL : PRODUCTION_BASE_URL) + endpoint;
  if (WRITE_ENDPOINTS.has(endpoint) && process.env.DRY_RUN === '1') {
    console.info(`[DRY_RUN] UPS ${endpoint} not sent`, requestXml);
    throw new UpsError(`DRY_RUN: UPS ${endpoint} not sent`);
  }
  const access = document(
    el('AccessRequest', [el('AccessLicenseNumber', accessKey), el('UserId', userId), el('Password', password)], { 'xml:lang': 'en-US' }),
  );
  let body: string;
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: access + requestXml,
      headers: { 'Content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'Accept-Charset': 'UTF-8' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    body = await res.text();
  } catch (e) {
    throw new UpsError(`Failure: ${e instanceof Error ? e.message : String(e)}`);
  }
  const xml = parseXml(body);
  const status = xml.Response?.ResponseStatusCode;
  if (status === undefined) throw new UpsError('Failure: response is in an unexpected format.');
  if (status === '0') {
    throw new UpsError(`Failure: ${str(xml.Response.Error?.ErrorDescription)} (${str(xml.Response.Error?.ErrorCode)})`);
  }
  return xml;
}

// ---- shared request pieces ----

interface Addr {
  line1?: unknown;
  line2?: unknown;
  line3?: unknown;
  city?: unknown;
  state?: unknown;
  postal?: unknown;
  country?: unknown;
}

// Ups\Entity\Address::toNode — only truthy parts are emitted
const phpTruthy = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === '' || v === 0 || v === '0');
const addressNode = (a: Addr): XmlNode =>
  el('Address', [
    phpTruthy(a.line1) && el('AddressLine1', a.line1),
    phpTruthy(a.line2) && el('AddressLine2', a.line2),
    phpTruthy(a.line3) && el('AddressLine3', a.line3),
    phpTruthy(a.city) && el('City', a.city),
    phpTruthy(a.state) && el('StateProvinceCode', a.state),
    phpTruthy(a.postal) && el('PostalCode', a.postal),
    phpTruthy(a.country) && el('CountryCode', a.country),
  ].filter((n): n is XmlNode => n !== false));

const requestNode = (action: string, option?: string): XmlNode =>
  el('Request', [el('TransactionReference'), el('RequestAction', action), option !== undefined && el('RequestOption', option)].filter((n): n is XmlNode => n !== false));

interface PackageInput {
  weight: unknown;
  length: unknown;
  width: unknown;
  height: unknown;
  references?: { code: string; value: unknown }[];
}

// Ups\Entity\Package::toNode with the defaults the client leaves in place
const packageNode = (p: PackageInput): XmlNode =>
  el('Package', [
    el('PackagingType', [el('Code', '02'), el('Description')]),
    el('PackageWeight', [el('Weight', p.weight), el('UnitOfMeasurement', [el('Code', 'LBS'), el('Description')])]),
    el('Dimensions', [el('Length', p.length), el('Height', p.height), el('Width', p.width), el('UnitOfMeasurement', [el('Code', 'IN'), el('Description')])]),
    el('PackageServiceOptions'),
    ...(p.references ?? []).map((r) => el('ReferenceNumber', [el('Code', r.code), el('Value', r.value)])),
  ]);

export class UpsClient {
  private key = process.env.UPS_ACCESS_KEY ?? '';
  private account = process.env.UPS_AI_ACCOUNT ?? '';
  private userId = process.env.UPS_USER_ID ?? '';
  private password = process.env.UPS_PASSWORD ?? '';
  private walmartAccount = process.env.UPS_WM_ACCOUNT ?? '';
  // Laravel env() turns the string "true" into boolean true; anything else stays falsy here
  private sandbox = ['true', '(true)'].includes((process.env.UPS_SANDBOX ?? '').toLowerCase());

  private send(endpoint: string, requestXml: string): Promise<XmlReply> {
    return request(this.key, this.userId, this.password, this.sandbox, endpoint, requestXml);
  }

  // Not caught by the PHP (its `catch (Exception)` resolves to the non-existent App\Libraries\Exception), so errors propagate.
  async validateAddress(street: string[], city: any, state: any, zipcode: any, country: any = 'US'): Promise<{ isValid: boolean; validAddress?: Record<string, unknown> }> {
    const lines = [street[0], street.length > 1 ? street[1] : undefined, street.length > 2 ? street[2] : undefined];
    const xml = document(
      el('AddressValidationRequest', [
        requestNode('XAV', '1'),
        el('MaximumListSize', 15),
        el('AddressKeyFormat', [
          el('ConsigneeName', 'Test Test'),
          el('BuildingName', 'Test'),
          ...lines.filter(phpTruthy).map((l) => el('AddressLine', l)),
          phpTruthy(state) && el('PoliticalDivision1', state),
          phpTruthy(city) && el('PoliticalDivision2', city),
          phpTruthy(country) && el('CountryCode', country),
          phpTruthy(zipcode) && el('PostcodePrimaryLow', zipcode),
        ].filter((n): n is XmlNode => n !== false)),
      ], { 'xml:lang': 'en-US' }),
    );
    const response = await this.send('/XAV', xml);
    if (!('ValidAddressIndicator' in response)) return { isValid: false };
    return { isValid: true, validAddress: avAddress(first(response.AddressKeyFormat)) };
  }

  // Throws on UPS errors (see validateAddress).
  async getRate(fromZip: any, toZip: any, weight: any, height: any, width: any, length: any): Promise<{ serviceType: string | null; amount: number | null; deliveryDate: string }[]> {
    const xml = document(
      el('RatingServiceSelectionRequest', [
        requestNode('Rate', 'Shoptimeintransit'),
        el('PickupType', [el('Code', '01'), el('Description')]),
        el('Shipment', [
          el('Service', [el('Code', '03'), el('Description')]),
          el('Shipper', [addressNode({ postal: fromZip })]),
          el('ShipFrom', [addressNode({ postal: fromZip })]),
          el('ShipTo', [el('CompanyName', 'Test Ship To'), el('AttentionName'), addressNode({ postal: toZip })]),
          packageNode({ weight, length, width, height }),
          el('ShipmentServiceOptions'),
          el('DeliveryTimeInformation', [el('PackageBillType', '03')]),
        ]),
      ], { 'xml:lang': 'en-US' }),
    );
    const root = await this.send('/Rate', xml);
    const rated = root.RatedShipment;
    const result = [];
    for (const r of rated === undefined ? [] : Array.isArray(rated) ? rated : [rated]) {
      // PHP dereferences these unguarded (a missing node is an ErrorException), so let them throw too
      const summary = r.TimeInTransit.ServiceSummary;
      const arrival = first(summary.EstimatedArrival).Arrival;
      result.push({
        serviceType: summary.Service.Description ?? null,
        amount: r.TotalCharges?.MonetaryValue === undefined ? null : Number(r.TotalCharges.MonetaryValue),
        deliveryDate: `${arrival.Date ?? ''} - ${arrival.Time ?? ''}`,
      });
    }
    return result;
  }

  async getLabel(
    orderId: any, po: any, from: any, serviceType: any, length: any, width: any, height: any, lb: any,
    name: any, phone: any, street: string[], city: any, state: any, zipcode: any, country: any = 'US', thirdParty: any = false,
  ): Promise<{ tracking: string; label: string; netcharge?: string } | null> {
    const fromAddr: Addr = {
      line1: from.Address.StreetLines[0],
      line2: from.Address.StreetLines[1],
      postal: from.Address.PostalCode,
      city: from.Address.City,
      state: from.Address.StateOrProvinceCode,
      country: from.Address.CountryCode,
    };
    const company = from.Contact.CompanyName;
    const serviceCode = serviceType === '' || String(serviceType).toUpperCase() === 'GROUND' ? '03' : String(serviceType);
    // Service::getName() on an unknown code is an undefined-index ErrorException outside the PHP try
    if (!(serviceCode in SERVICE_NAMES)) throw new Error(`Undefined index: ${serviceCode}`);

    const references = [];
    if (orderId !== null && orderId !== undefined && orderId !== '') references.push({ code: 'IK', value: orderId });
    if (po !== null && po !== undefined && po !== '') references.push({ code: 'PO', value: po });

    const payment = phpTruthy(thirdParty)
      ? el('PaymentInformation', [
          el('BillThirdParty', [
            el('BillThirdPartyShipper', [
              el('AccountNumber', this.walmartAccount),
              el('ThirdParty', [
                el('Address', [phpTruthy(from.Address.PostalCode) && el('PostalCode', from.Address.PostalCode), el('CountryCode', from.Address.CountryCode)].filter((n): n is XmlNode => n !== false)),
              ]),
            ]),
          ]),
        ])
      : el('PaymentInformation', [el('Prepaid', [el('BillShipper', phpTruthy(this.account) ? [el('AccountNumber', this.account)] : [])])]);

    const shipperTo = (n: string, withAccount: boolean, a: Addr, who: unknown, phoneNo: unknown, attention: unknown) =>
      el(n, [
        withAccount ? el('Name', who) : el('CompanyName', who),
        phpTruthy(attention) && el('AttentionName', attention),
        withAccount && el('ShipperNumber', this.account),
        phpTruthy(phoneNo) && el('PhoneNumber', phoneNo),
        addressNode(a),
      ].filter((x): x is XmlNode => x !== false));

    const confirmXml = document(
      el('ShipmentConfirmRequest', [
        requestNode('ShipConfirm', 'validate'),
        el('Shipment', [
          shipperTo('Shipper', true, fromAddr, company, from.Contact.PhoneNumber, company),
          shipperTo('ShipTo', false, { line1: street[0], line2: street.length > 1 ? street[1] : undefined, postal: zipcode, city, state, country }, name, phone, name),
          shipperTo('ShipFrom', false, fromAddr, company, from.Contact.PhoneNumber, company),
          payment,
          el('Service', [el('Code', serviceCode), el('Description', SERVICE_NAMES[serviceCode])]),
          el('RateInformation', [el('NegotiatedRatesIndicator')]),
          packageNode({ weight: lb, length, width, height, references }),
          el('ShipmentServiceOptions'),
        ]),
        el('LabelSpecification', [el('LabelPrintMethod', [el('Code', 'GIF')]), el('LabelImageFormat', [el('Code', 'GIF')])]),
      ]),
    );

    try {
      const confirm = await this.send('/ShipConfirm', confirmXml);
      const acceptXml = document(
        el('ShipmentAcceptRequest', [requestNode('ShipAccept'), el('ShipmentDigest', confirm.ShipmentDigest)]),
      );
      const accept = (await this.send('/ShipAccept', acceptXml)).ShipmentResults;

      const labelFile = `${orderId}.gif`;
      // imagerotate($image, 270) is counter-clockwise 270 = clockwise 90; imagegif re-encodes
      const rotated = await sharp(Buffer.from(accept.PackageResults.LabelImage.GraphicImage, 'base64')).rotate(90).gif().toBuffer();
      const labels = disk('labels');
      const prefix = labels.pathPrefix().replace(/\/?$/, '/');
      await labels.put(`labels/${labelFile}`, rotated);
      await chmod(join(prefix, `labels/${labelFile}`), 0o666);

      const info: { tracking: string; label: string; netcharge?: string } = {
        tracking: accept.ShipmentIdentificationNumber,
        label: `${prefix}labels/${labelFile}`,
      };
      const grandTotal = accept.NegotiatedRates?.NetSummaryCharges?.GrandTotal;
      if (grandTotal !== undefined) info.netcharge = grandTotal.MonetaryValue;
      return info;
    } catch (e) {
      // PHP also echoes "ERROR" and var_dump()s the exception into the response body; not reproduced.
      console.error('[UpsClient] getLabel failed', e);
      return null;
    }
  }

  // Resolves the library's void reply (without its Response node), or null when anything failed.
  async deleteShipment(trackingId: string): Promise<XmlReply | null> {
    const xml = document(
      el('VoidShipmentRequest', [
        requestNode('1'),
        el('ExpandedVoidShipment', [el('ShipmentIdentificationNumber', trackingId.toUpperCase())]),
      ]),
    );
    try {
      const { Response: _response, ...reply } = await this.send('/Void', xml);
      return reply;
    } catch (e) {
      console.error('[UpsClient] deleteShipment failed', e instanceof Error ? e.message : e);
      return null;
    }
  }
}

// Ups\Entity\AddressValidation\AVAddress as json_encode()d (public properties, declaration order)
function avAddress(key: any): Record<string, unknown> {
  if (typeof key !== 'object' || Object.keys(key).length === 0) {
    throw new Error('Ups\\Entity\\AddressValidation\\AVAddress::__construct: The passed object does not have any child nodes.');
  }
  const classification = key.AddressClassification;
  if (classification !== undefined && (typeof classification !== 'object' || Object.keys(classification).length === 0)) {
    throw new Error('AddressClassification::__construct: The passed object does not have any child nodes.');
  }
  const out: Record<string, unknown> = {
    addressClassification: classification === undefined ? null : { code: str(classification.Code), description: str(classification.Description) },
    consigneeName: str(key.ConsigneeName),
    buildingName: str(key.BuildingName),
    addressLine: null,
    addressLine2: null,
    addressLine3: null,
    region: str(key.Region),
    politicalDivision2: str(key.PoliticalDivision2),
    politicalDivision1: str(key.PoliticalDivision1),
    postcodePrimaryLow: str(key.PostcodePrimaryLow),
    postcodeExtendedLow: str(key.PostcodeExtendedLow),
    urbanization: str(key.Urbanization),
    countryCode: str(key.CountryCode),
  };
  const lines = key.AddressLine === undefined ? [] : Array.isArray(key.AddressLine) ? key.AddressLine : [key.AddressLine];
  lines.forEach((l: unknown, i: number) => {
    out[`addressLine${i > 0 ? i + 1 : ''}`] = str(l);
  });
  return out;
}
