// Port of the old app's App\Libraries\Wayfair (Wayfair Supplier GraphQL API + OAuth client-credentials token).
// Ported (the methods with callers): fetchToken, getOrders, acceptOrder, rejectOrder, getInventory, updateFullInventory,
// updateInventory, RegisterOrder, GetPackingSlip, plus sendRequest / sendGraphQLRequest / flattenQuery.
// Skipped (no caller in app/): the unused ORDER_QUERY / INVENTORY_UPDATE_QUERY constants, downloadFile,
// curlAppendQuery, curlParseHeaders and the commented-out curl helpers.
//
// GraphQL payloads are built by string concatenation exactly like the PHP (including the `\"` escapes and whitespace);
// sendGraphQLRequest strips \r \n \t from the JSON body. Not reproduced: the PHP `echo`/`print_r` debug output (it printed
// the access token) and `exit(1)` on failure — failures throw WayfairError instead.
//
// Every outbound call goes through request(). Writes (acceptOrder, rejectOrder, updateFullInventory, updateInventory,
// RegisterOrder = generates the shipping label) are logged and NOT sent when DRY_RUN=1; the token POST and the
// read queries (getOrders, getInventory) and GetPackingSlip are always sent.

import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { disk } from '../storage.js';
import { date } from '../view.js';

export class WayfairError extends Error {}
export class WayfairDryRunError extends Error {}

export interface WayfairRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface WayfairResponse {
  status: number;
  body: Buffer;
}

type WayfairTransport = (req: WayfairRequest) => Promise<WayfairResponse>;

const fetchTransport: WayfairTransport = async (req) => {
  const url = new URL(req.url);
  if (url.protocol !== 'https:') throw new WayfairError(`Wayfair: only https is allowed: ${req.url}`);
  const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body || undefined, signal: AbortSignal.timeout(120_000) });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

let transport: WayfairTransport = fetchTransport;

// Test seam so unit tests never call wayfair.com.
export function setWayfairTransportForTests(fn: WayfairTransport | null): void {
  transport = fn ?? fetchTransport;
}

// The single outbound seam.
export function request(req: WayfairRequest): Promise<WayfairResponse> {
  return transport(req);
}

const AUTH_URL = 'https://sso.auth.wayfair.com/oauth/token';
const VARIABLES = 'null';
const INVENTORY_QUERY =
  'query inventory { inventory(limit: 10) {  supplierPartNumber,  quantityOnHand,  quantityBackordered,  quantityOnOrder, discontinued,          itemNextAvailabilityDate  }  } ';

const SUPPLIER_ID = 49188;

const saveResult = `id,
          handle,
          status,
          submittedAt,
          completedAt,
          errors {
            key,
            message
          }`;

const inventoryQuery = (feedKind: 'TRUE_UP' | 'DIFFERENTIAL') => `mutation save (
      $inventory: [inventoryInput]!
    ) {
      inventory {
        save (
          inventory: $inventory,
          feedKind: ${feedKind}
        ) {
          ${saveResult}
        }
      }
    }`;

export interface WayfairInventoryItem {
  ItemNumber: string;
  ItemQuantityOnHand: number | string;
}

export interface WayfairOrderLine {
  sku: string;
  qty: number | string;
  price?: number | string;
  promiseDate?: string;
  shipLevel?: string;
}

const inventoryVariables = (items: WayfairInventoryItem[]) => {
  let vars = ` {
      "inventory": [
      `;
  for (const w of items) {
    vars += ` {
          "supplierId": ${SUPPLIER_ID},
          "supplierPartNumber": "${w.ItemNumber}",
          "quantityOnHand": ${w.ItemQuantityOnHand}
          } ,`;
  }
  vars = vars.slice(0, -1);
  return (vars += `
    ]
}`);
};

export class Wayfair {
  private apiUrl = process.env.WAYFAIR_API_URL ?? '';
  private clientId = process.env.WAYFAIR_CLIENT ?? '';
  private clientSecret = process.env.WAYFAIR_SECRET ?? '';
  private audience = process.env.WAYFAIR_AUDIENCE ?? '';
  private accessToken: string | null;

  constructor(token: string | null = null) {
    this.accessToken = token;
  }

  // Raw reply body; any status other than 200 throws (PHP: \Exception "Request failed with status code ...").
  private async sendRequestRaw(method: string, url: string, body = '', headers: string[] = []): Promise<Buffer> {
    const headerMap = Object.fromEntries(headers.map((h) => [h.slice(0, h.indexOf(':')), h.slice(h.indexOf(':') + 1).trim()]));
    const res = await request({ method, url, headers: headerMap, body: body !== '' ? body : undefined });
    if (res.status !== 200) throw new WayfairError(`Request failed with status code ${res.status}, response ${res.body.toString('utf8')}`);
    return res.body;
  }

  async sendRequest(method: string, url: string, body = '', headers: string[] = []): Promise<string> {
    return (await this.sendRequestRaw(method, url, body, headers)).toString('utf8');
  }

  // `write` (not in PHP) marks mutations so DRY_RUN=1 can stop them before any HTTP.
  async sendGraphQLRequest(token: string, query: string, variables: string, write = false): Promise<any> {
    const headers = ['Content-Type: application/json', 'Cache-Control: no-cache', 'Authorization: Bearer ' + token];
    const graphQLPayload = this.flattenQuery(`{"query": "${query}", "variables": ${variables}}`);
    if (write && process.env.DRY_RUN === '1') {
      console.info(`[DRY_RUN] Wayfair POST ${this.apiUrl} not sent`, graphQLPayload);
      throw new WayfairDryRunError('DRY_RUN: Wayfair GraphQL mutation not sent');
    }
    try {
      return JSON.parse(await this.sendRequest('POST', this.apiUrl, graphQLPayload, headers));
    } catch (e) {
      throw new WayfairError(`Problem executing the GraphQL request: ${(e as Error).message}`);
    }
  }

  async fetchToken(): Promise<string> {
    const authPayload = `
              {
                "grant_type": "client_credentials",
                "client_id": "${this.clientId}",
                "client_secret": "${this.clientSecret}",
                "audience": "${this.audience}"
              }
    `;
    try {
      const response = JSON.parse(await this.sendRequest('POST', AUTH_URL, authPayload, ['Content-Type: application/json', 'Cache-Control: no-cache']));
      this.accessToken = response.access_token;
      return response.access_token;
    } catch (e) {
      throw new WayfairError(`Could not retrieve a token for the request: ${(e as Error).message}`);
    }
  }

  flattenQuery(query: string): string {
    return query.replace(/\n/g, '').replace(/\r/g, '').replace(/\t/g, '');
  }

  // PHP calls an undefined bare fetchToken() in some methods when no token is set (fatal error); fetching one is the
  // only behaviour that makes sense and no caller reaches it (all construct with a token or fetch one first).
  private async token(): Promise<string> {
    return this.accessToken ?? (await this.fetchToken());
  }

  async getOrders(): Promise<any> {
    const orderQuery = `query getDropshipPurchaseOrders {
getDropshipPurchaseOrders (
limit:100,
hasResponse: false,
fromDate: \\"${date('Y-m-d')}\\"
) {
poNumber,
poDate,
estimatedShipDate,
customerName,
packingSlipUrl,
shippingInfo {
  shipSpeed,
  carrierCode
}
warehouse {
  id,
  name,
  address {
    name,
    address1,
    address2,
    address3,
    city,
    state,
    country,
    postalCode
  }
},
products {
  partNumber,
  quantity,
  price,
  name,
  estShipDate,
  event {
    id,
    type,
    name,
    startDate,
    endDate
  }
},
shipTo {
  name,
  address1,
  address2,
  address3,
  city,
  state,
  country,
  postalCode,
  phoneNumber
}
}
}`;
    return this.sendGraphQLRequest(await this.token(), orderQuery, VARIABLES);
  }

  async acceptOrder(order: { orderId: string }, orderDetail: WayfairOrderLine[]): Promise<any> {
    const token = await this.token();
    if (Array.isArray(orderDetail) && orderDetail.length > 0) {
      let acceptQuery = `mutation accept {
            purchaseOrders {
              accept (
                poNumber: \\"${order.orderId}\\",
                shipSpeed: ${orderDetail[0].shipLevel},
                lineItems: [
                  `;
      for (const od of orderDetail) {
        acceptQuery += ` {
                      partNumber: \\"${od.sku}\\",
                      quantity: ${od.qty},
                      unitPrice: ${od.price},
                      estimatedShipDate: \\"${String(od.promiseDate).slice(0, 10)}\\"
                      } ,`;
      }
      acceptQuery = acceptQuery.slice(0, -1);
      acceptQuery += `
                ]
              ) {
                id,
                handle,
                status,
                submittedAt,
                completedAt,
                errors {
                  key,
                  message
                }
              }
            }
          }`;
      return this.sendGraphQLRequest(token, acceptQuery, VARIABLES, true);
    }
    return '';
  }

  async rejectOrder(order: { orderId: string }, orderDetail: WayfairOrderLine[]): Promise<any> {
    const token = await this.token();
    let rejectQuery = `mutation reject {
      purchaseOrders {
        reject (
          poNumber: \\"${order.orderId}\\",
          lineItems: [
            `;
    for (const od of orderDetail) {
      rejectQuery += ` {
                partNumber: \\"${od.sku}\\",
                quantity: ${od.qty}
                } ,`;
    }
    rejectQuery = rejectQuery.slice(0, -1);
    rejectQuery += `
          ]
        ) {
          id,
          handle,
          status,
          submittedAt,
          completedAt,
          errors {
            key,
            message
          }
        }
      }
    }`;
    return this.sendGraphQLRequest(token, rejectQuery, VARIABLES, true);
  }

  async getInventory(): Promise<any> {
    return this.sendGraphQLRequest(await this.token(), INVENTORY_QUERY, VARIABLES);
  }

  async updateFullInventory(wayfairItems: WayfairInventoryItem[]): Promise<any> {
    return this.sendGraphQLRequest(await this.token(), inventoryQuery('TRUE_UP'), inventoryVariables(wayfairItems), true);
  }

  async updateInventory(wayfairItems: WayfairInventoryItem[]): Promise<any> {
    return this.sendGraphQLRequest(await this.token(), inventoryQuery('DIFFERENTIAL'), inventoryVariables(wayfairItems), true);
  }

  // Returns the PO number once the label PDF is saved to the `labels` disk (labels/<po>.pdf), else the GraphQL reply.
  async RegisterOrder(poNumber: string): Promise<any> {
    const registerQuery = `mutation register {
        purchaseOrders {
          register (
            registrationInput: {
              poNumber: \\"${poNumber}\\",
              warehouseId: ${SUPPLIER_ID}
            }
          ) {
            id,
            consolidatedShippingLabel {
              url
            }
          }
        }
      }`;
    const token = await this.token();
    const graphQLResponse = await this.sendGraphQLRequest(token, registerQuery, VARIABLES, true);
    const label = graphQLResponse?.data?.purchaseOrders?.register?.consolidatedShippingLabel;
    if (label != null) {
      const headers = ['Content-Type: application/json', 'Cache-Control: no-cache', 'Authorization: Bearer ' + token];
      const labelResponse = await this.sendRequestRaw('GET', label.url, '', headers);
      const labels = disk('labels');
      await labels.put(`labels/${poNumber}.pdf`, labelResponse);
      await chmod(join(labels.pathPrefix(), `labels/${poNumber}.pdf`), 0o666);
      return poNumber;
    }
    return graphQLResponse;
  }

  async GetPackingSlip(poNumber: string): Promise<string> {
    const headers = ['Content-Type: application/json', 'Cache-Control: no-cache', 'Authorization: Bearer ' + (await this.token())];
    return this.sendRequest('GET', this.audience + '/v1/packing_slip/' + poNumber, '', headers);
  }
}
