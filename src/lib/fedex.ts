// Port of the old app's App\Libraries\FedexClient (legacy FedEx Web Services SOAP,
// WSDLs copied to config/fedex/). Only methods that controllers call are ported:
// getRate, getOneRate, validateAddress, getLabel, deleteShipment (+ the add* request
// helpers they use). Skipped: trackShipment (no caller), createShipment (no caller;
// references undefined variables and an uninstalled FedEx\ShipService package).
//
// Every outbound SOAP call goes through request(). Write operations (see
// WRITE_OPERATIONS) are logged and NOT sent when DRY_RUN=1.

import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import * as soap from 'soap';
import { nowDb } from '../db.js';
import { config } from '../config.js';
import { disk } from '../storage.js';
import { number_format } from '../view.js';
import { pruneToSchema } from './stamps.js';

type Params = Record<string, unknown>;

interface PackageLineItem {
  SequenceNumber: number;
  GroupPackageCount: number;
  Weight: { Value: unknown; Units: string };
  Dimensions: { Length: unknown; Width: unknown; Height: unknown; Units: string };
  CustomerReferences?: { CustomerReferenceType: string; Value: unknown }[];
  SpecialServicesRequested?: Params;
}

// Mirrors PHP's SoapFault: any transport / SOAP-level failure.
export class FedexFault extends Error {
  constructor(public faultstring: string) {
    super(faultstring);
  }
}

export type FedexService = 'rate' | 'ship' | 'addressvalidation';

export const WRITE_OPERATIONS = new Set(['processShipment', 'deleteShipment']);

const SERVICES: Record<FedexService, { wsdl: string; path: string }> = {
  rate: { wsdl: 'RateService_v28.wsdl', path: '/rate' },
  ship: { wsdl: 'ShipService_v23.wsdl', path: '/ship' },
  addressvalidation: { wsdl: 'AddressValidationService_v4.wsdl', path: '/addressvalidation' },
};

export interface FedexRate {
  serviceType: string;
  amount: string;
  deliveryDate: string;
}

export interface FedexLabel {
  tracking: string;
  label: string;
  netcharge?: number;
}

type Transport = (service: FedexService, operation: string, params: Params) => Promise<any>;

const wsdlClients = new Map<FedexService, Promise<any>>();

function wsdlClient(service: FedexService): Promise<any> {
  if (!wsdlClients.has(service)) {
    const file = new URL(`../../config/fedex/${SERVICES[service].wsdl}`, import.meta.url).pathname;
    wsdlClients.set(service, soap.createClientAsync(file));
  }
  return wsdlClients.get(service)!;
}

// PHP's SoapClient (WSDL mode) encodes xsd:boolean as true/false; node-soap would write 1/0 as-is.
function coerceBooleans(value: any, desc: any): any {
  if (typeof desc === 'string') return desc.endsWith(':boolean') ? phpBool(value) : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => coerceBooleans(v, desc));
  const out: Params = {};
  for (const [k, v] of Object.entries(value)) out[k] = coerceBooleans(v, desc?.[k] ?? desc?.[`${k}[]`]);
  return out;
}

// PHP's SoapClient returns a repeating element seen once as the bare object (array only for 2+);
// node-soap always returns an array for maxOccurs>1 elements. Collapse to PHP's shape.
function unwrapSingletons(value: any): any {
  if (Array.isArray(value)) return value.length === 1 ? unwrapSingletons(value[0]) : value.map(unwrapSingletons);
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrapSingletons(v)]));
}

function faultString(e: any): string {
  return e?.root?.Envelope?.Body?.Fault?.faultstring ?? e?.message ?? String(e);
}

const soapTransport: Transport = async (service, operation, params) => {
  const client = await wsdlClient(service);
  client.setEndpoint(`${process.env.FEDEX_URL}${SERVICES[service].path}`);
  const desc = Object.values<any>(Object.values<any>(client.describe())[0])[0][operation].input;
  try {
    const [result] = await client[`${operation}Async`](coerceBooleans(pruneToSchema(params, desc), desc));
    return unwrapSingletons(result);
  } catch (e) {
    throw new FedexFault(faultString(e));
  }
};

let transport: Transport = soapTransport;

// Test seam so unit tests never reach FedEx.
export function setFedexTransportForTests(fn: Transport | null): void {
  transport = fn ?? soapTransport;
}

// The single outbound seam. Throws FedexFault on a SOAP fault (like SoapClient).
export async function request(service: FedexService, operation: string, params: Params): Promise<any> {
  if (WRITE_OPERATIONS.has(operation) && process.env.DRY_RUN === '1') {
    const { WebAuthenticationDetail: _credentials, ...logged } = params;
    console.info(`[DRY_RUN] FedEx ${operation} not sent`, JSON.stringify(logged));
    throw new FedexFault(`DRY_RUN: FedEx ${operation} not sent`);
  }
  return transport(service, operation, params);
}

// PHP truthiness / loose comparison with ''.
function phpBool(v: unknown): boolean {
  return !(v === null || v === undefined || v === false || v === '' || v === 0 || v === '0' || (Array.isArray(v) && v.length === 0));
}
const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '' || v === 0 || v === false;

// PHP date('c') in the app timezone.
function dateC(d = new Date()): string {
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: config.APP_TIMEZONE, timeZoneName: 'longOffset' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')!.value.slice(3);
  return `${nowDb(d).replace(' ', 'T')}${offset || '+00:00'}`;
}

const failed = (response: any): boolean => response.HighestSeverity === 'FAILURE' || response.HighestSeverity === 'ERROR';

function logFault(e: unknown): void {
  console.error('[FedexClient]', e instanceof FedexFault ? e.faultstring : e);
}

export class FedexClient {
  private serviceUrl = process.env.FEDEX_URL;
  private key = process.env.FEDEX_KEY;
  private account = process.env.FEDEX_ACCOUNT;
  private walmartAccount = process.env.FEDEX_WALMART_ACCOUNT;
  private meter = process.env.FEDEX_METER;
  private password = process.env.FEDEX_PASSWORD;

  addRecipient(name: any, isResidential: any, street: any, city: any, state: any, zipcode: any, country: any = 'US', phone: any = ''): Params {
    return {
      Contact: { PersonName: name, CompanyName: '', PhoneNumber: phone },
      Address: {
        StreetLines: street,
        City: city,
        StateOrProvinceCode: state,
        PostalCode: zipcode,
        CountryCode: country,
        Residential: isResidential ? 1 : 0,
      },
    };
  }

  addShippingChargesPayment(): Params {
    return {
      PaymentType: 'SENDER',
      Payor: { ResponsibleParty: { AccountNumber: this.account, CountryCode: 'US' } },
    };
  }

  addThirdPartyChargesPayment(): Params {
    return {
      PaymentType: 'THIRD_PARTY',
      Payor: { ResponsibleParty: { AccountNumber: this.walmartAccount, CountryCode: 'US' } },
    };
  }

  addLabelSpecification(): Params {
    return { LabelFormatType: 'COMMON2D', ImageType: 'PNG', LabelStockType: 'PAPER_4X6' };
  }

  addSpecialServicesOneRate(): Params {
    return { SpecialServiceTypes: ['FEDEX_ONE_RATE'] };
  }

  addSpecialServicesSignature(): Params {
    return { SpecialServiceTypes: ['SIGNATURE_OPTION'], SignatureOptionDetail: { OptionType: 'ADULT' } };
  }

  addPackageLineItem1(signature: any, length: any, width: any, height: any, lb: any, orderId: any = '', po: any = ''): PackageLineItem {
    const item: PackageLineItem = {
      SequenceNumber: 1,
      GroupPackageCount: 1,
      Weight: { Value: lb, Units: 'LB' },
      Dimensions: { Length: length, Width: width, Height: height, Units: 'IN' },
    };
    if (!isBlank(orderId)) {
      (item.CustomerReferences ??= []).push({ CustomerReferenceType: 'CUSTOMER_REFERENCE', Value: orderId });
    }
    if (!isBlank(po)) {
      (item.CustomerReferences ??= []).push({ CustomerReferenceType: 'P_O_NUMBER', Value: po });
    } else if (!isBlank(orderId)) {
      item.CustomerReferences!.push({ CustomerReferenceType: 'P_O_NUMBER', Value: orderId });
    }
    if (phpBool(signature)) item.SpecialServicesRequested = this.addSpecialServicesSignature();
    return item;
  }

  // Header fields every FedEx request starts with.
  private envelope(transactionId: string, serviceId: string, major: string): Params {
    return {
      WebAuthenticationDetail: { UserCredential: { Key: this.key, Password: this.password } },
      ClientDetail: { AccountNumber: this.account, MeterNumber: this.meter },
      TransactionDetail: { CustomerTransactionId: transactionId },
      Version: { ServiceId: serviceId, Major: major, Intermediate: '0', Minor: '0' },
    };
  }

  deleteShipment(trackingId: string): Promise<'OK' | null> {
    return this.callOrFault(async () => {
      const req = {
        ...this.envelope(`Delete shipment ${trackingId}`, 'ship', '23'),
        TrackingId: { TrackingIdType: 'FEDEX', TrackingNumber: trackingId },
        ShipTimestamp: dateC(),
        DeletionControl: 'DELETE_ONE_PACKAGE',
      };
      const response = await request('ship', 'deleteShipment', req);
      if (!failed(response)) return 'OK' as const;
      console.error('[FedexClient]', JSON.stringify(response));
      return null;
    }, null);
  }

  getLabel(
    orderId: any, po: any, shipper: any, packageType: any, serviceType: any, length: any, width: any, height: any, lb: any,
    isResidential: any, signature: any, name: any, phone: any, street: any, city: any, state: any, zipcode: any,
    country: any = 'US', thirdParty: any = false,
  ): Promise<FedexLabel | null> {
    return this.callOrFault(async () => {
      const shipment: Params = { DropoffType: 'REGULAR_PICKUP', ShipTimestamp: dateC() };
      if (serviceType != 'FEDEX_GROUND') {
        shipment.ServiceType = serviceType;
        shipment.PackagingType = packageType;
      } else {
        shipment.PackagingType = 'YOUR_PACKAGING';
        shipment.ServiceType = isResidential ? 'GROUND_HOME_DELIVERY' : 'FEDEX_GROUND';
      }
      if (['FEDEX_ENVELOPE', 'FEDEX_PAK', 'FEDEX_SMALL_BOX', 'FEDEX_MEDIUM_BOX'].includes(packageType)) {
        shipment.SpecialServicesRequested = this.addSpecialServicesOneRate();
      }
      shipment.Shipper = shipper;
      shipment.Recipient = this.addRecipient(name, isResidential, street, city, state, zipcode, country, phone);
      shipment.ShippingChargesPayment = phpBool(thirdParty) ? this.addThirdPartyChargesPayment() : this.addShippingChargesPayment();
      shipment.PackageCount = '1';
      if (serviceType == 'FEDEX_GROUND') {
        shipment.RequestedPackageLineItems = this.addPackageLineItem1(signature, length, width, height, lb, orderId, po);
      } else {
        const references: Params[] = [{ CustomerReferenceType: 'CUSTOMER_REFERENCE', Value: orderId }];
        if (!isBlank(po)) references.push({ CustomerReferenceType: 'P_O_NUMBER', Value: po });
        shipment.RequestedPackageLineItems = {
          SequenceNumber: 1,
          GroupPackageCount: 1,
          Weight: { Value: lb, Units: 'LB' },
          CustomerReferences: references,
        };
      }
      shipment.LabelSpecification = this.addLabelSpecification();

      const response = await request('ship', 'processShipment', {
        ...this.envelope(' *** Rate Request using PHP ***', 'ship', '23'),
        ReturnTransitAndCommit: true,
        RequestedShipment: shipment,
      });
      if (failed(response)) {
        console.error('[FedexClient]', JSON.stringify(response));
        return null;
      }
      let trackingId = response.CompletedShipmentDetail.MasterTrackingId.TrackingNumber;
      const pkg = response.CompletedShipmentDetail.CompletedPackageDetails;
      if (pkg.TrackingIds !== undefined && pkg.TrackingIds !== null) trackingId = pkg.TrackingIds.TrackingNumber;
      const labels = disk('labels');
      const prefix = labels.pathPrefix().replace(/\/?$/, '/');
      const image: unknown = pkg.Label.Parts.Image;
      await labels.put(`labels/${orderId}.png`, Buffer.isBuffer(image) ? image : Buffer.from(String(image), 'base64'));
      await chmod(join(prefix, `labels/${orderId}.png`), 0o666);

      const info: FedexLabel = { tracking: trackingId, label: `${prefix}labels/${orderId}.png` };
      const amount = pkg.PackageRating?.PackageRateDetails?.NetCharge?.Amount;
      if (amount !== undefined) info.netcharge = Number(amount);
      return info;
    }, null);
  }

  // PHP returns [] when nothing validated, else ['Classification' =>, 'EffectiveAddress' =>].
  validateAddress(street: any, city: any, state: any, zipcode: any, country: any = 'US'): Promise<[] | { Classification: any; EffectiveAddress: any }> {
    return this.callOrFault(async () => {
      const response = await request('addressvalidation', 'addressValidation', {
        ...this.envelope(' *** Rate Request using PHP ***', 'aval', '4'),
        ReturnTransitAndCommit: true,
        RequestedShipment: { DropoffType: 'REGULAR_PICKUP' },
        AddressesToValidate: [
          {
            ClientReferenceId: 'ClientReferenceId1',
            Address: { StreetLines: street, PostalCode: zipcode, City: city, StateOrProvinceCode: state, CountryCode: country },
          },
        ],
      });
      if (failed(response)) return [] as [];
      const result = response.AddressResults;
      return { Classification: result.Classification, EffectiveAddress: result.EffectiveAddress };
    }, [] as []);
  }

  getRate(
    shipper: any, length: any, width: any, height: any, lb: any, isResidential: any, signature: any,
    street: any, city: any, state: any, zipcode: any, country: any = 'US',
  ): Promise<FedexRate[]> {
    return this.callOrFault(async () => {
      const response = await request('rate', 'getRates', {
        ...this.envelope(' *** Rate Request using PHP ***', 'crs', '28'),
        ReturnTransitAndCommit: true,
        RequestedShipment: {
          DropoffType: 'REGULAR_PICKUP',
          ShipTimestamp: dateC(),
          ServiceType: isResidential ? 'GROUND_HOME_DELIVERY' : 'FEDEX_GROUND',
          PackagingType: 'YOUR_PACKAGING',
          Shipper: shipper,
          Recipient: this.addRecipient('test', isResidential, street, city, state, zipcode, country),
          ShippingChargesPayment: this.addShippingChargesPayment(),
          PackageCount: '1',
          RequestedPackageLineItems: this.addPackageLineItem1(signature, length, width, height, lb),
        },
      });
      return this.ratesFrom(response);
    }, []);
  }

  getOneRate(
    shipper: any, length: any, width: any, height: any, lb: any, packaging: any, isResidential: any,
    street: any, city: any, state: any, zipcode: any, country: any = 'US', serviceType: any = 'FEDEX_EXPRESS_SAVER',
  ): Promise<FedexRate[]> {
    return this.callOrFault(async () => {
      // the weight is commented out of the PHP package line item, so $lb is unused
      const response = await request('rate', 'getRates', {
        ...this.envelope(' *** Rate Request using PHP ***', 'crs', '28'),
        ReturnTransitAndCommit: true,
        RequestedShipment: {
          SpecialServicesRequested: this.addSpecialServicesOneRate(),
          DropoffType: 'REGULAR_PICKUP',
          ShipTimestamp: dateC(),
          ServiceType: serviceType,
          PackagingType: packaging,
          Shipper: shipper,
          Recipient: this.addRecipient('test', isResidential, street, city, state, zipcode, country),
          ShippingChargesPayment: this.addShippingChargesPayment(),
          PackageCount: '1',
          RequestedPackageLineItems: { SequenceNumber: 1, GroupPackageCount: 1 },
        },
      });
      return this.ratesFrom(response);
    }, []);
  }

  // Shared tail of getRate / getOneRate (identical in PHP).
  private ratesFrom(response: any): FedexRate[] {
    const result: FedexRate[] = [];
    if (failed(response)) {
      console.error('[FedexClient]', JSON.stringify(response));
      return result;
    }
    const details = response.RateReplyDetails;
    // PHP locals persist across loop iterations and are an undefined-variable error when never set
    let amount: string | undefined;
    let deliveryDate: string | undefined;
    for (const rateReply of Array.isArray(details) ? details : [details]) {
      const rated = rateReply.RatedShipmentDetails;
      if (rated && Array.isArray(rated)) {
        amount = number_format(Number(rated[0].ShipmentRateDetail.TotalNetCharge.Amount), 2, '.', ',');
      } else if (rated && !Array.isArray(rated)) {
        amount = number_format(Number(rated.ShipmentRateDetail.TotalNetCharge.Amount), 2, '.', ',');
      }
      if (Object.hasOwn(rateReply, 'DeliveryTimestamp')) deliveryDate = rateReply.DeliveryTimestamp;
      else if (Object.hasOwn(rateReply, 'TransitTime')) deliveryDate = rateReply.TransitTime;
      if (amount === undefined) throw new Error('Undefined variable: amount');
      if (deliveryDate === undefined) throw new Error('Undefined variable: deliveryDate');
      result.push({ serviceType: rateReply.ServiceType, amount, deliveryDate });
    }
    return result;
  }

  // PHP: catch (SoapFault) -> Log::error, then the method's fall-through return value.
  private async callOrFault<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FedexFault) {
        logFault(e);
        return fallback;
      }
      throw e;
    }
  }
}
