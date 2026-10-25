// Port of the old app's App\Libraries\Frayun (Frayun SOAP client, WSDL config/frayun.xml).
// Ported: getStateAbbr, getBalance, buyLabel, downloadLabel (the only methods FrayunController /
// FrayunMassPrintLabel call). Skipped: generateRandomString (only used by commented-out code),
// sendHttpRequest (private, no caller), the unused $fromAddress property (controllers keep their own).
//
// Every outbound SOAP call goes through request(). buyLabel (CreatePreToJson) buys postage, so it is
// logged and NOT sent when DRY_RUN=1.

import * as soap from 'soap';
import { db, nowDb } from '../db.js';
import { json_encode, substr } from '../view.js';

type Params = Record<string, unknown>;
type Transport = (operation: string, params: Params) => Promise<any>;

// Mirrors PHP's SoapFault: callers would read `.faultstring` (the PHP callers never catch it).
export class FrayunFault extends Error {
  constructor(public faultstring: string) {
    super(faultstring);
  }
}

export const WRITE_OPERATIONS = new Set(['CreatePreToJson']);

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

let wsdlClientPromise: Promise<any> | undefined;

function wsdlClient(): Promise<any> {
  wsdlClientPromise ??= soap.createClientAsync(new URL('../../config/frayun.xml', import.meta.url).pathname);
  return wsdlClientPromise;
}

function faultString(e: any): string {
  return e?.root?.Envelope?.Body?.Fault?.faultstring ?? e?.message ?? String(e);
}

const soapTransport: Transport = async (operation, params) => {
  const client = await wsdlClient();
  const fn = client[`${operation}Async`];
  if (typeof fn !== 'function') {
    throw new FrayunFault(`Function ("${operation}") is not a valid method for this service`);
  }
  try {
    const [result] = await fn.call(client, params);
    return result;
  } catch (e) {
    throw new FrayunFault(faultString(e));
  }
};

let transport: Transport = soapTransport;

// Test seam so unit tests never reach Frayun.
export function setFrayunTransportForTests(fn: Transport | null): void {
  transport = fn ?? soapTransport;
}

// The single outbound seam. Throws FrayunFault on a SOAP fault (like SoapClient).
export async function request(operation: string, params: Params): Promise<any> {
  if (WRITE_OPERATIONS.has(operation) && process.env.DRY_RUN === '1') {
    const { UserName: _user, PassWord: _password, ...logged } = params;
    console.info(`[DRY_RUN] Frayun ${operation} not sent`, JSON.stringify(logged));
    throw new FrayunFault(`DRY_RUN: Frayun ${operation} not sent`);
  }
  return transport(operation, params);
}

function credentials() {
  return { UserName: process.env.FRAYUN_USERNAME ?? '', PassWord: process.env.FRAYUN_PASSWORD ?? '' };
}

// PHP string interpolation of a scalar: null/false -> ''
const php = (v: unknown): string => (v === null || v === undefined || v === false ? '' : String(v));

// PHP: isset($a['k']) ? $a['k'] : ''
const field = (a: Record<string, unknown> | null | undefined, key: string): string => php(a?.[key]);

// PHP: date("YmdHis") in the app timezone
const clientStamp = (): string => nowDb().replace(/\D/g, '');

// PHP: trim() default character set
const phpTrim = (v: unknown): string => php(v).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

export class Frayun {
  static getStateAbbr(stateName: string): string | undefined {
    const key = php(stateName).toUpperCase();
    return Object.hasOwn(STATES, key) ? STATES[key] : undefined;
  }

  async getBalance(): Promise<string> {
    const response = await request('GetBalance', credentials());
    return String(response.GetBalanceResult);
  }

  // Returns CreatePreToJsonResult: a JSON string such as '[{"DpdNo":...,"ResultCode":"00000",...}]'.
  async buyLabel(
    orderId: unknown, fromAddress: Record<string, unknown>, toAddress: Record<string, unknown>, ref: unknown, sihpDate: unknown,
    weightInKg: unknown, lengthInCm: unknown, heightInCm: unknown, widthInCm: unknown, products: unknown = [],
  ): Promise<string> {
    // fromAddress is unused by the PHP too (only logged)
    void fromAddress;
    const order = phpTrim(orderId);
    let productJson = `[{
            "ProduceNameCN":"order ${order}",
            "ProduceNameEN":"order ${order}",
            "USD":"200",
            "SalePrice":"200",
            "Packages":"1",
            "Sku":"${order}",
            "Weight":"${php(weightInKg)}"
        }]`;
    // PHP is_array(): JS arrays and assoc-array objects; sizeof() > 0
    if (products !== null && typeof products === 'object' && Object.keys(products).length > 0) {
      productJson = json_encode(products);
    }
    // Hand-built, unescaped JSON on purpose (same as the PHP).
    const jsonData = `
        {
            "ClientNumber":"${php(orderId)}*${clientStamp()}",

            "ReceiveName":"${field(toAddress, 'Name')}",
            "ReceiveComName":"${field(toAddress, 'Company')}",
            "ReceiveTel":"${field(toAddress, 'Phone')}",
            "ReceiveEmail":"",
            "ReceiveAddress":"${field(toAddress, 'Address1')} ${field(toAddress, 'Address2')}",
            "ReceiveCity":"${field(toAddress, 'City')}",
            "ReceiveProvince":"${field(toAddress, 'State')}",
            "ReceiveCountry":"United States of America",
            "ReceiveCode":"${field(toAddress, 'ZIPCode')}",
            "SendType":"${php(process.env.FRAYUN_SENDTYPE)}",
            "IsCharged":0,
            "IsReturnAddress":1,
            "ActualWeight":${php(weightInKg)},            
            "VolumeHeight":${php(heightInCm)},
            "VolumeLength":${php(lengthInCm)},
            "VolumeWidth":${php(widthInCm)},
            "VolumeWeight":${php(weightInKg)},
            "SerialNumber":"${php(process.env.FRAYUN_ADDRESS_NO)}",
            "Ref":"${php(ref)}",
            "Ref2":"",
            "IsScanForm":0,
            "ShipDate":"${php(sihpDate)}",
            "JsonProductInfo":${productJson}
            }`;
    const response = await request('CreatePreToJson', { ...credentials(), JsonData: jsonData });
    return response.CreatePreToJsonResult;
  }

  // Returns GetPdfPreResult (a JSON string carrying the label PDF). Read-only lookup of an existing label.
  async downloadLabel(dpdNo: unknown): Promise<string> {
    const response = await request('GetPdfPre', { ...credentials(), DpdNo: dpdNo });
    return response.GetPdfPreResult;
  }
}

// Zone chart + discounted rate lookup shared by FrayunController::frayunBuyLabel and FrayunMassPrintLabel.
export async function zoneAndDiscountedRate(
  fromZip3: string, toZip: string, totalOz: number, serviceType: string,
): Promise<{ zone: number; discountedRate: number | string }> {
  let discountedRate: number | string = 0;
  let zone = 0;
  const zoneChartException = await db
    .selectFrom('os_shipping_zone_charts_exception')
    .selectAll()
    .where('originalZip', '=', fromZip3)
    .where('rangeFrom', '<=', substr(toZip, 0, 5))
    .where('rangeTo', '>=', substr(toZip, 0, 5))
    .executeTakeFirst();
  if (zoneChartException === undefined) {
    const zoneChart = await db
      .selectFrom('os_shipping_zone_charts')
      .selectAll()
      .where('originalZip', '=', fromZip3)
      .where('rangeFrom', '<=', substr(toZip, 0, 3))
      .where('rangeTo', '>=', substr(toZip, 0, 3))
      .executeTakeFirst();
    if (zoneChart !== undefined) zone = zoneChart.zone;
    // else: Log::info('no in zone chart')
  } else {
    zone = zoneChartException.zone;
  }
  if (zone !== 0) {
    console.info(`to ${toZip} zone ${zone}`);
    if (totalOz < 16 && serviceType === 'FIRST CLASS') {
      const rateChart = await db
        .selectFrom('os_shipping_rate_chart')
        .selectAll()
        .where('ServiceType', '=', 'F')
        .where('StartWeight', '<=', String(totalOz)) // SAFETY: DECIMAL column; MySQL compares '5' == 5
        .where('EndWeight', '>', String(totalOz)) // SAFETY: same
        .where('Zone', '=', zone)
        .executeTakeFirst();
      if (rateChart !== undefined) discountedRate = rateChart.Price;
    } else {
      const totalLb = totalOz / 16.0;
      const rateChart = await db
        .selectFrom('os_shipping_rate_chart')
        .selectAll()
        .where('ServiceType', '=', 'P')
        .where('StartWeight', '<=', String(totalLb)) // SAFETY: DECIMAL column; MySQL compares '1.5' == 1.5
        .where('EndWeight', '>', String(totalLb)) // SAFETY: same
        .where('Zone', '=', zone)
        .executeTakeFirst();
      if (rateChart !== undefined) discountedRate = rateChart.Price;
    }
  }
  return { zone, discountedRate };
}
