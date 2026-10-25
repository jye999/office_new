// Port of the old app's App\Libraries\Stamps (Stamps.com SWSIM SOAP client).
// Only methods that routed code / Runner / jobs call are ported. Skipped:
// getRates() (no caller; it also reads an undefined $toAddress), the private
// authenticator helpers (getAuthenicator, saveAuthenticatorToDB — dead since
// the Authenticator was replaced by per-request Credentials), json/random
// helpers are inlined below.
//
// Every outbound SOAP call goes through request(). Write operations (see
// WRITE_OPERATIONS) are logged and NOT sent when DRY_RUN=1.

import * as soap from 'soap';
import { nowDb } from '../db.js';

type Params = Record<string, any>;
export type StampsAddress = Record<string, any>;

// Mirrors PHP's SoapFault: callers read `.faultstring`.
export class StampsFault extends Error {
  constructor(public faultstring: string) {
    super(faultstring);
  }
}

export interface StampsResult {
  success: 'true' | 'false';
  response?: any;
  message?: any;
  step?: string;
  Address?: any;
}

export const WRITE_OPERATIONS = new Set(['CreateIndicium', 'PurchasePostage', 'CreateScanForm', 'CancelIndicium']);

type Transport = (operation: string, params: Params) => Promise<any>;

const STATES: Record<string, string> = {
  'ALABAMA': 'AL',
  'ALASKA': 'AK',
  'ARIZONA': 'AZ',
  'ARKANSAS': 'AR',
  'CALIFORNIA': 'CA',
  'COLORADO': 'CO',
  'CONNECTICUT': 'CT',
  'DELAWARE': 'DE',
  'FLORIDA': 'FL',
  'GEORGIA': 'GA',
  'HAWAII': 'HI',
  'IDAHO': 'ID',
  'ILLINOIS': 'IL',
  'INDIANA': 'IN',
  'IOWA': 'IA',
  'KANSAS': 'KS',
  'KENTUCKY': 'KY',
  'LOUISIANA': 'LA',
  'MAINE': 'ME',
  'MARYLAND': 'MD',
  'MASSACHUSETTS': 'MA',
  'MICHIGAN': 'MI',
  'MINNESOTA': 'MN',
  'MISSISSIPPI': 'MS',
  'MISSOURI': 'MO',
  'MONTANA': 'MT',
  'NEBRASKA': 'NE',
  'NEVADA': 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  'OHIO': 'OH',
  'OKLAHOMA': 'OK',
  'OREGON': 'OR',
  'PENNSYLVANIA': 'PA',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  'TENNESSEE': 'TN',
  'TEXAS': 'TX',
  'UTAH': 'UT',
  'VERMONT': 'VT',
  'VIRGINIA': 'VA',
  'WASHINGTON': 'WA',
  'WEST VIRGINIA': 'WV',
  'WISCONSIN': 'WI',
  'WYOMING': 'WY',
  'BRITISH COLUMBIA': 'BC',
  'ONTARIO': 'ON',
  'NEWFOUNDLAND AND LABRADOR': 'NL',
  'NOVA SCOTIA': 'NS',
  'PRINCE EDWARD ISLAND': 'PE',
  'NEW BRUNSWICK': 'NB',
  'QUEBEC': 'QC',
  'MANITOBA': 'MB',
  'SASKATCHEWAN': 'SK',
  'ALBERTA': 'AB',
  'NORTHWEST TERRITORIES': 'NT',
  'NUNAVUT': 'NU',
  'YUKON TERRITORY': 'YT',
};

const wsdlClients = new Map<string, Promise<any>>();

function wsdlPath(): string {
  return new URL(`../../config/stamps.${process.env.STAMPS_MODE}.xml`, import.meta.url).pathname;
}

function wsdlClient(): Promise<any> {
  const file = wsdlPath();
  if (!wsdlClients.has(file)) wsdlClients.set(file, soap.createClientAsync(file));
  return wsdlClients.get(file)!;
}

// PHP SoapClient (WSDL mode) only encodes elements the schema knows: unknown keys
// (e.g. the 'AddOn' key getRatesNoCleanse sends) are dropped, and a numeric list
// given for a type whose only member is a repeating element becomes that element.
// node-soap serialises unknown keys verbatim, so prune to the described input.
export function pruneToSchema(value: any, desc: any): any {
  if (desc === null || typeof desc !== 'object') return value;
  const fields = Object.keys(desc).filter((k) => k !== 'targetNSAlias' && k !== 'targetNamespace');
  const only = fields.length === 1 && fields[0].endsWith('[]') ? fields[0] : null;
  if (Array.isArray(value)) {
    if (!only) return value;
    return { [only.slice(0, -2)]: value.map((v) => pruneToSchema(v, desc[only])) };
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Params = {};
  for (const field of fields) {
    const name = field.replace(/(\[\]|\?)$/, '');
    if (value[name] === undefined) continue;
    out[name] = field.endsWith('[]') && Array.isArray(value[name])
      ? value[name].map((v: any) => pruneToSchema(v, desc[field]))
      : pruneToSchema(value[name], desc[field]);
  }
  return out;
}

function faultString(e: any): string {
  return e?.root?.Envelope?.Body?.Fault?.faultstring ?? e?.message ?? String(e);
}

export const soapTransport: Transport = async (operation, params) => {
  const client = await wsdlClient();
  const fn = client[`${operation}Async`];
  if (typeof fn !== 'function') {
    // PHP: SoapFault 'Function ("X") is not a valid method for this service'
    throw new StampsFault(`Function ("${operation}") is not a valid method for this service`);
  }
  const desc = client.describe().SwsimV135?.SwsimV135Soap?.[operation]?.input;
  try {
    const [result] = await fn.call(client, pruneToSchema(params, desc));
    return result;
  } catch (e) {
    throw new StampsFault(faultString(e));
  }
};

let transport: Transport = soapTransport;

// Test seam so unit tests never reach Stamps.com.
export function setStampsTransportForTests(fn: Transport | null): void {
  transport = fn ?? soapTransport;
}

// The single outbound seam. Throws StampsFault on a SOAP fault (like SoapClient).
export async function request(operation: string, params: Params): Promise<any> {
  if (WRITE_OPERATIONS.has(operation) && process.env.DRY_RUN === '1') {
    const { Credentials: _credentials, ...logged } = params;
    console.info(`[DRY_RUN] Stamps ${operation} not sent`, JSON.stringify(logged));
    throw new StampsFault(`DRY_RUN: Stamps ${operation} not sent`);
  }
  return transport(operation, params);
}

function credentials() {
  return {
    IntegrationID: process.env.STAMPS_INTEGRATIONID ?? '',
    Username: process.env.STAMPS_USERNAME ?? '',
    Password: process.env.STAMPS_PASSWORD ?? '',
  };
}

// PHP is_numeric()
function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

// PHP: urldecode()
function urldecode(s: string): string {
  return s.replace(/\+/g, ' ').replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => Buffer.from(m.replace(/%/g, ''), 'hex').toString('utf8'));
}

// PHP: json_clean_decode() — strips /* */ and ` //` comments, then json_decode(assoc).
function jsonCleanDecode(json: string): any {
  const stripped = json.replace(/(\/\*([^*]|[\r\n]|(\*+([^*/]|[\r\n])))*\*+\/)|([\s\t](\/\/).*)/g, '');
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function generateRandomString(length = 10): string {
  const characters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < length; i++) out += characters[Math.floor(Math.random() * characters.length)];
  return out;
}

// PHP: date('Y-m-d') in the app timezone.
function today(): string {
  return nowDb().slice(0, 10);
}

// PHP: loose `$x == 1` on an SOAP xsd:boolean / int
function isOne(v: unknown): boolean {
  return v === true || (isNumeric(v) && Number(v) === 1);
}

// PHP: sizeof() of an array / assoc array
function phpCount(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  return v !== null && typeof v === 'object' ? Object.keys(v).length : 0;
}

export class Stamps {
  static getStateAbbr(stateName: string): string {
    const key = String(stateName).toUpperCase();
    return Object.hasOwn(STATES, key) ? STATES[key] : key;
  }

  async getCleanse(address: StampsAddress): Promise<StampsResult> {
    return this.cleaseAddress(address);
  }

  // Shared by getRatesNoCleanse / getRatesOnlyNoCleanse (identical in PHP apart from
  // the Carrier key and the cleanse call).
  private rateRequest(
    toAddress: StampsAddress, fromAddress: StampsAddress, lb: unknown, oz: unknown, length: unknown, width: unknown,
    height: unknown, packageType: unknown, insuranceAmount: unknown, declaredValue: unknown, carrier?: string,
  ): Params {
    if (!isNumeric(declaredValue)) declaredValue = 0;
    const requestParams: Params = {
      Credentials: credentials(),
      Rate: {
        From: fromAddress,
        To: toAddress,
        ShipDate: today(),
        WeightLb: lb,
        WeightOz: oz,
        Length: length,
        Width: width,
        Height: height,
        PackageType: packageType,
        NonMachinable: false,
        RectangularShaped: true,
      },
    };
    if (carrier) requestParams.Carrier = carrier;
    const insured = isNumeric(insuranceAmount) && Number(insuranceAmount) > 0;
    requestParams.Rate.InsuredValue = insured ? insuranceAmount : 0;
    // The PHP uses the key 'AddOn' (WSDL says 'AddOnV20'); the SoapClient dropped it. request()
    // prunes it the same way, so keep the key verbatim.
    if (insured) requestParams.Rate.AddOns = { AddOn: { Amount: insuranceAmount, AddOnType: 'US-A-INS' } };
    if (isNumeric(declaredValue) && Number(declaredValue) > 0) requestParams.Rate.DeclaredValue = declaredValue;
    return requestParams;
  }

  async getRatesNoCleanse(
    toAddress: StampsAddress, fromAddress: StampsAddress, lb: unknown, oz: unknown, length: unknown, width: unknown,
    height: unknown, packageType: unknown, insuranceAmount: unknown, declaredValue: unknown,
  ): Promise<StampsResult> {
    const cleanseResponse = await this.cleaseAddress(toAddress);
    const requestParams = this.rateRequest(
      toAddress, fromAddress, lb, oz, length, width, height, packageType, insuranceAmount, declaredValue, 'USPS',
    );
    try {
      const response = await request('GetRates', requestParams);
      // PHP: $cleanseResponse['response']->Address — undefined index/property -> ErrorException
      if (cleanseResponse.response === undefined) throw new Error('Undefined index: response');
      return { success: 'true', response, Address: cleanseResponse.response.Address };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      console.info('Stamps GetRates request', JSON.stringify({ ...requestParams, Credentials: undefined }));
      return { success: 'false', step: 'GetRates failed', message: e.faultstring };
    }
  }

  async getUpsRates(
    toAddress: StampsAddress, fromAddress: StampsAddress, lb: unknown, oz: unknown, length: unknown, width: unknown,
    height: unknown, insuranceAmount: unknown, declaredValue: unknown,
  ): Promise<StampsResult> {
    if (!isNumeric(declaredValue)) declaredValue = 0;
    const requestParams: Params = {
      Credentials: credentials(),
      Rate: {
        From: fromAddress,
        To: toAddress,
        ShipDate: today(),
        WeightLb: lb,
        WeightOz: oz,
        Length: length,
        Width: width,
        Height: height,
        PackageType: 'Package',
        NonMachinable: false,
        RectangularShaped: true,
      },
      Carrier: 'UPS',
    };
    if (isNumeric(insuranceAmount) && Number(insuranceAmount) > 0) {
      requestParams.Rate.InsuredValue = insuranceAmount;
      requestParams.Rate.AddOns = { AddOn: { Amount: insuranceAmount, AddOnType: 'CAR-A-INS' } };
    } else {
      requestParams.Rate.InsuredValue = 0;
    }
    if (isNumeric(declaredValue) && Number(declaredValue) > 0) requestParams.Rate.DeclaredValue = declaredValue;
    try {
      const response = await request('GetRates', requestParams);
      return { success: 'true', response };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      console.info('UPS GetRates failed: ' + e.faultstring);
      return { success: 'false', step: 'UPS GetRates failed', message: e.faultstring };
    }
  }

  // Returns the raw GetRates response on success, but the failure ARRAY on a fault (PHP quirk).
  async getRatesOnlyNoCleanse(
    toAddress: StampsAddress, fromAddress: StampsAddress, lb: unknown, oz: unknown, length: unknown, width: unknown,
    height: unknown, packageType: unknown, insuranceAmount: unknown, declaredValue: unknown,
  ): Promise<any> {
    const requestParams = this.rateRequest(
      toAddress, fromAddress, lb, oz, length, width, height, packageType, insuranceAmount, declaredValue,
    );
    try {
      return await request('GetRates', requestParams);
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      console.info('Stamps GetRates request', JSON.stringify({ ...requestParams, Credentials: undefined }));
      return { success: 'false', step: 'GetRates failed', message: e.faultstring };
    }
  }

  private async getAccountInfo(): Promise<StampsResult> {
    try {
      return { success: 'true', response: await request('GetAccountInfo', { Credentials: credentials() }) };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      return { success: 'false', message: e };
    }
  }

  private async cleaseAddress(address: StampsAddress): Promise<StampsResult> {
    const requestParams: Params = { Credentials: credentials(), Address: { ...address } };
    if (address.Country != 'US') {
      requestParams.Address.PostalCode = address.ZIPCode;
      delete requestParams.Address.ZIPCode;
    }
    try {
      const response = await request('CleanseAddress', requestParams);
      if (isOne(response.AddressMatch) && isOne(response.CityStateZipOK)) return { success: 'true', response };
      return { success: 'false', message: 'Invalid Address', response };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      return { success: 'false', message: e.faultstring };
    }
  }

  // WRITE (spends money): CreateIndicium. Not sent when DRY_RUN=1.
  async buyLabel(
    _authenticator: unknown, rateParam: string, fromAddress: StampsAddress, toAddress: StampsAddress, memo: unknown,
    customs: unknown, needSignature: unknown = false,
  ): Promise<StampsResult> {
    const rate: Params = jsonCleanDecode(urldecode(rateParam)) ?? {};
    const isUps = typeof rate.ServiceType === 'string' && rate.ServiceType.startsWith('UPS-');
    const signature = needSignature === true || needSignature === 'true';
    const additions: Params[] = [];
    if (rate.AddOns?.AddOnV20 != null) {
      let addons = rate.AddOns.AddOnV20;
      if (addons.AddOnType != null) addons = [addons];
      for (const addon of Object.values(addons) as any[]) {
        if (addon === null || typeof addon !== 'object' || Array.isArray(addon) || addon.AddOnType == null) continue;
        const amountOk = addon.Amount != null && isNumeric(addon.Amount);
        if (isUps) {
          // CAR-A-RES / SUR-* are applied by Stamps and rejected on CreateIndicium.
          if (addon.AddOnType == 'CAR-A-INS' && amountOk) additions.push({ AddOnType: 'CAR-A-INS', Amount: addon.Amount });
          if (signature && ['CAR-A-SR', 'CAR-A-ASR', 'CAR-A-DSR'].includes(addon.AddOnType) && amountOk) {
            additions.push({ AddOnType: addon.AddOnType, Amount: addon.Amount });
          }
        } else {
          if (addon.AddOnType == 'SC-A-HP') additions.push(addon);
          if (addon.AddOnType == 'US-A-INS' && amountOk) additions.push(addon);
          if (signature && addon.AddOnType == 'US-A-SC' && amountOk) additions.push(addon);
        }
      }
    }
    const to = { ...toAddress };
    if (isUps && (to.PhoneNumber == null || String(to.PhoneNumber).trim() === '')) to.PhoneNumber = '678-999-6232';
    rate.InsuredValue = 0;
    rate.AddOns = additions;
    delete rate.Surcharges;
    delete rate.surcharges;
    const requestParams: Params = {
      Credentials: credentials(),
      IntegratorTxID: generateRandomString(),
      Rate: rate,
      From: fromAddress,
      To: to,
    };
    if (phpCount(customs) > 0) requestParams.Customs = customs;
    requestParams.memo = String(memo ?? '');
    try {
      return { success: 'true', response: await request('CreateIndicium', requestParams) };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      const fs = e.faultstring.toUpperCase();
      if (fs.includes('INVALID CONVERSATION TOKEN') || fs.includes('EXPIRED AUTHENTICATOR') || fs.includes('OUT-OF-SYNC')) {
        return this.buyLabel('', rateParam, fromAddress, toAddress, memo, customs, needSignature);
      }
      console.error(e.faultstring);
      return { success: 'false', message: e.faultstring };
    }
  }

  // The PHP builds the request but the CancelIndicium call is commented out: it does nothing.
  cancelLabel(_stampsTxId: string): void {}

  async accountInfo(): Promise<StampsResult> {
    return this.getAccountInfo();
  }

  // WRITE (spends money): PurchasePostage. Not sent when DRY_RUN=1.
  async purchasePostage(amount: unknown, controlTotal: unknown): Promise<StampsResult> {
    const requestParams = { Credentials: credentials(), PurchaseAmount: amount, ControlTotal: controlTotal };
    try {
      return { success: 'true', response: await request('PurchasePostage', requestParams) };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      return { success: 'false', message: e };
    }
  }

  async getTracking(stampsTxID: string, _authenticator: unknown = null): Promise<StampsResult> {
    try {
      const response = await request('TrackShipment', { Credentials: credentials(), StampsTxID: stampsTxID });
      return { success: 'true', response };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      return { success: 'false', message: e };
    }
  }

  async getUrl(urlPage: string, _authenticator: unknown = null): Promise<StampsResult> {
    try {
      const response = await request('GetURL', { Credentials: credentials(), URLType: urlPage, ApplicationContext: '' });
      return { success: 'true', response };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      return { success: 'false', message: e };
    }
  }

  // WRITE: CreateScanForm. Not sent when DRY_RUN=1. (The v135 WSDL has no CreateScanForm operation,
  // so against the real service this always returns the SoapFault "not a valid method", as in PHP.)
  async printScanForm(stampsTxIDs: unknown[] | null, fromAddress: StampsAddress, _authenticator: unknown = null): Promise<StampsResult> {
    let requestParams: Params = {
      Credentials: credentials(),
      StampsTxIDs: stampsTxIDs,
      FromAddress: fromAddress,
      ImageType: 'Png',
      PrintInstructions: false,
    };
    // PHP: `$stampsTxIDs==null || sizeof($stampsTxIDs)` — a null OR non-empty list drops StampsTxIDs.
    if (stampsTxIDs == null || stampsTxIDs.length > 0) {
      requestParams = {
        Credentials: credentials(),
        ShipDate: today(),
        FromAddress: fromAddress,
        ImageType: 'Png',
        PrintInstructions: false,
      };
    }
    try {
      return { success: 'true', response: await request('CreateScanForm', requestParams) };
    } catch (e) {
      if (!(e instanceof StampsFault)) throw e;
      return { success: 'false', message: e };
    }
  }
}
