// UnshippedController store pages 1–5, enfloral, refreshNotes
// (routes/web.php:141-147, role:admin,user,remote). Safe GET /enfloral is
// parity-tested; /unshipped3 GET hits the live angelisabella feed (mocked in
// tests via the service seam); /unshipped1-refreshNotes calls the eBay
// Trading API and WRITES os_grant_order/os_grant_orderdetail (never called
// in tests — the eBay transport would be stubbed first).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Kysely } from 'kysely';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { currentUser } from '../../auth.js';
import { any, route } from '../../router.js';
import { render } from '../../view.js';
import { Ebay, xmlText } from '../../lib/ebay.js';
import { prepareStore1, prepareStore2, prepareStore3, prepareStore4, prepareStore5, type Row } from './service.js';

const ROLES = ['admin', 'user', 'remote'];
type User = { company_id?: number } | null;
// os_mades / os_priority are not in the generated DB map (see service.ts).
// SAFETY: both tables exist in the office schema; only the typed map omits them.
const raw = db as unknown as Kysely<{ os_mades: any; os_priority: any }>;
void raw;

// refreshNotes(): fetch eBay sale-record details for every unshipped store-E
// order detail, persist notes/address/price back, then re-render store1().
// $i->save() / $o->save() write the whole row -> updated_at (nowDb).
async function runRefreshNotes(): Promise<void> {
  const ebay = new Ebay();
  const rows = await db.selectFrom('os_grant_order').selectAll().where('store', '=', 'E').where('status', 'is', null).execute();
  const orderIds = rows.map((o) => o.orderId);
  const ds = orderIds.length ? await db.selectFrom('os_grant_orderdetail').selectAll().where('orderId', 'in', orderIds).execute() : [];
  const orders = rows.map((o) => ({ ...o, detail: ds.filter((d) => d.orderId === o.orderId) }));
  for (const o of orders) {
    let noteFromBuyer = '';
    let selfNotes = '';
    for (const i of o.detail as Row[]) {
      const itemID = String(i.itemId ?? '').split('-');
      const detail = await ebay.getSaleRecordDetail(itemID[1], itemID[0]);
      if (xmlText(detail['Ack']) === 'Success') {
        const sold = (detail['SellingManagerSoldOrder'] ?? {}) as Row;
        const nfb = sold['NotesFromBuyer'];
        if (nfb != null) noteFromBuyer += xmlText(nfb);
        const nts = sold['NotesToSeller'];
        if (nts != null) selfNotes += xmlText(nts);
        const addr = (sold['ShippingAddress'] ?? {}) as Row;
        await db
          .updateTable('os_grant_orderdetail')
          .set({ ...i, price: sold['TotalAmount'] ?? i.price, updated_at: nowDb() } as never)
          .where('id', '=', i.id as never)
          .execute();
        await db
          .updateTable('os_grant_order')
          .set({
            ...o,
            recipientName: xmlText(addr['Name']),
            address1: xmlText(addr['Street1']),
            address2: xmlText(addr['Street2']),
            city: xmlText(addr['CityName']),
            state: xmlText(addr['StateOrProvince']),
            zip: xmlText(addr['PostalCode']),
            country: xmlText(addr['Country']),
            updated_at: nowDb(),
          } as never)
          .where('id', '=', o.id)
          .execute();
      }
    }
    await db
      .updateTable('os_grant_order')
      .set({ ...o, notesFromBuyer: noteFromBuyer, selfNotes, updated_at: nowDb() } as never)
      .where('id', '=', o.id)
      .execute();
  }
}

async function store1Handler(req: FastifyRequest, reply: FastifyReply) {
  const user = (await currentUser(req)).user as User;
  return render(req, reply, 'unshipped1', await prepareStore1(user));
}

export function registerUnshippedRoutes(app: FastifyInstance): void {
  route(app, {
    verb: 'get',
    path: '/unshipped5',
    name: 'unshipped5',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const user = (await currentUser(req)).user as User;
      return render(req, reply, 'unshipped5', await prepareStore5(user, 'S'));
    },
  });
  route(app, {
    verb: 'get',
    path: '/enfloral',
    name: 'enfloral',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const user = (await currentUser(req)).user as User;
      return render(req, reply, 'enfloral', await prepareStore5(user, 'EF'));
    },
  });
  route(app, {
    verb: 'get',
    path: '/unshipped4',
    name: 'unshipped4',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const user = (await currentUser(req)).user as User;
      const showDesktop = input(req, 'showDesktop') != null;
      return render(req, reply, 'unshipped4', await prepareStore4(user, showDesktop));
    },
  });
  route(app, {
    verb: 'get',
    path: '/unshipped3',
    name: 'unshipped3',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const user = (await currentUser(req)).user as User;
      return render(req, reply, 'unshipped3', await prepareStore3(user));
    },
  });
  route(app, {
    verb: 'get',
    path: '/unshipped2',
    name: 'unshipped2',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const user = (await currentUser(req)).user as User;
      const showDesktop = input(req, 'showDesktop') != null;
      return render(req, reply, 'unshipped2', await prepareStore2(user, showDesktop));
    },
  });
  any(app, {
    path: '/unshipped1',
    name: 'unshipped1',
    roles: ROLES,
    handler: store1Handler,
  });
  any(app, {
    path: '/unshipped1-refreshNotes',
    name: 'unshipped1-refreshNotes',
    roles: ROLES,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      await runRefreshNotes();
      return store1Handler(req, reply);
    },
  });
}
