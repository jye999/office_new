// MessageController (/msg, /reloadAllMsg) + UserMessageController
// (/getUserMsg, /flagUserMsg, /deleteMsg, /showMessage, /showSentMessage,
// /sendMessage, /getUserList, /messageFileUpload).
// All in the web.php:107 group role:admin,user,remote (plus the controllers'
// own `auth` middleware).
//
// SimpleXML quirk (plan/NOTES.md): the old code's `$resp->Messages->Message`
// is the FIRST <Message> element; `foreach` iterates its scalar CHILD
// elements, whose `->MessageID` is always null. So /msg never matches a row
// to update Text, and /reloadAllMsg's saveMessage() attempts an all-null
// insert that strict MySQL rejects -> 500 whenever the eBay inbox has at
// least one message.

import type { FastifyInstance } from 'fastify';
import { currentUser } from '../../auth.js';
import type { Expression } from 'kysely';
import { db, nowDb, sql } from '../../db.js';
import { input } from '../../http.js';
import { disk } from '../../storage.js';
import { image } from '../../images.js';
import { trigger } from '../../pusher.js';
import { any, route } from '../../router.js';
import { render, renderToString } from '../../view.js';
import { ebayGetMyMessages, type EbayMessage } from '../../lib/ebay.js';

const MIDDLEWARE = ['web', 'role:admin,user,remote'];

// response()->json(x) for values Fastify would send as text/empty (strings,
// null): JSON-encode and set the JSON content type. JSON.stringify(null) is
// the literal 'null' (Fastify sends the string, not an empty body).
function jsonValue(reply: import('fastify').FastifyReply, value: unknown): void {
  reply.type('application/json; charset=utf-8').send(JSON.stringify(value));
}

// PHP 7.4 `$x == 0` for request strings: numeric strings compare numerically,
// empty and non-numeric strings compare equal to 0.
function eqZero(v: unknown): boolean {
  const t = String(v).trim();
  if (t === '') return true;
  return /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) === 0 : true;
}

// os_users serialized the way Eloquent does: all columns in table order minus
// $hidden (password, remember_token).
function serializeUser(row: Record<string, unknown>): Record<string, unknown> {
  const { password: _password, remember_token: _remember_token, ...rest } = row;
  return rest;
}

// os_user_message rows + the hasOne User relations. Laravel stores a loaded
// relation at the LOWERCASE attribute key, REPLACING the scalar column in
// place (verified against the live old app's /getUserMsg JSON), so the key
// order stays: id, created_at, updated_at, from_user, to_user, message,
// hasRead, deleted.
async function withUserRelations(
  rows: Record<string, unknown>[],
  rels: ('from_user' | 'to_user')[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const copy: Record<string, unknown> = { ...row };
    for (const key of rels) {
      const fk = row[key];
      const user =
        fk === null || fk === undefined
          ? null
          : await db.selectFrom('os_users').selectAll().where('id', '=', Number(fk)).executeTakeFirst();
      // SAFETY: user is a full os_users row; serializeUser drops $hidden only.
      copy[key] = user ? serializeUser(user as unknown as Record<string, unknown>) : null;
    }
    out.push(copy);
  }
  return out;
}

// saveMessage(): $messages is the first <Message> element (or null); foreach
// iterates its child elements, each treated as an all-null Message row.
async function saveEbayMessages(first: EbayMessage | null): Promise<void> {
  for (const childKey of first ? Object.keys(first) : []) {
    // Message::where('MessageID', '=', null)->first() never matches (NOT NULL
    // PK), so the else branch builds a new all-null Message and save() runs an
    // insert that strict MySQL rejects -> 500, same as the old app.
    void childKey;
    await db
      .insertInto('os_messages')
      .values({
        // SAFETY: nulls reproduce the PHP insert of an all-null model; the
        // insert must fail exactly like the old app's (strict mode, NOT NULL).
        MessageID: null as unknown as string,
        // SAFETY: nulls (cont.).
        Sender: null as unknown as string,
        // SAFETY: nulls (cont.).
        RecipientUserID: null as unknown as string,
        // SAFETY: nulls (cont.).
        Read: null as unknown as number,
        // SAFETY: nulls (cont.).
        Flagged: null as unknown as number,
        // SAFETY: nulls (cont.).
        Replied: null as unknown as number,
        // SAFETY: nulls (cont.) reproduce the all-null model insert.
        Subject: null as unknown as string,
        // SAFETY: nulls (cont.).
        ReceiveDate: null as unknown as Date,
        // SAFETY: nulls (cont.).
        MessageType: null as unknown as string,
        ItemID: null,
        ItemTitle: null,
        ResponseURL: null,
        // SAFETY: nowDb() returns 'YYYY-MM-DD HH:mm:ss' strings (cont.).
        created_at: nowDb() as unknown as Date,
        // SAFETY: nowDb() (cont.).
        updated_at: nowDb() as unknown as Date,
      })
      .execute();
  }
}

// print_r($msgResp->Messages): PHP's object dump for the Messages node.
// shortcut: covers the reachable shapes (null, empty, one message); upgrade
// if a live /msg ever reaches a deeper shape.
// print_r($msgResp->Messages, true) — verified byte-for-byte against
// php:7.4-cli (empty node: "SimpleXMLElement Object\n(\n)\n").
function printRMessages(messages: EbayMessage[] | null): string {
  if (messages === null) return 'NULL';
  let out = 'Messages: SimpleXMLElement Object\n(\n';
  messages.forEach((m, i) => {
    const key = messages.length === 1 ? 'Message' : String(i);
    out += `    [${key}] => SimpleXMLElement Object\n        (\n`;
    for (const [k, v] of Object.entries(m)) {
      if (v !== null) out += `            [${k}] => ${v}\n`;
    }
    out += '        )\n\n';
  });
  return out + ')\n';
}

async function registerMessageController(app: FastifyInstance): Promise<void> {
  route(app, {
    verb: 'get',
    path: '/msg',
    name: 'msg',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const userId = input<string>(req, 'user');
      const myName = 'bridalfavor';
      // Message::where('Sender','=',u)->orWhere('RecipientUserID','=',u);
      // null u binds NULL -> `= NULL` matches nothing, like Laravel.
      // SAFETY: nullId may be null (binds NULL); Kysely types reject it.
      const nullId = (userId ?? null) as unknown as string;
      // SAFETY: rows are full os_messages rows; the handlers only read columns.
      const msgs = (await db
        .selectFrom('os_messages')
        .selectAll()
        // SAFETY: Kysely 0.29 does not accept RawBuilder in where(); runtime is fine.
        .where(sql`(Sender = ${nullId} or RecipientUserID = ${nullId})` as unknown as Expression<never>)
        .orderBy('ReceiveDate', 'desc')
        .execute()) as unknown as Record<string, unknown>[];
      const messageIDs0: string[] = [];
      const messageIDs1: string[] = [];
      for (const msg of msgs) {
        (String(msg.RecipientUserID) === myName ? messageIDs0 : messageIDs1).push(String(msg.MessageID));
        if (messageIDs0.length === 9) {
          // ReturnMessages fetch; the SimpleXML-quirk match never updates Text.
          await ebayGetMyMessages('ReturnMessages', messageIDs0);
          messageIDs0.length = 0;
        }
        if (messageIDs1.length === 9) {
          await ebayGetMyMessages('ReturnMessages', messageIDs1, '1');
          messageIDs1.length = 0;
        }
      }
      let prefix = '';
      if (messageIDs0.length > 0) {
        const resp = await ebayGetMyMessages('ReturnMessages', messageIDs0);
        // PHP sizeof($resp->Messages->Message) > 1 = the first <Message> has
        // more than one child element.
        if (resp.messages && resp.messages[0] && Object.keys(resp.messages[0]).length > 1) {
          // foreach over the first message's children: no row matches, no writes.
        } else {
          prefix = printRMessages(resp.messages);
        }
      }
      if (messageIDs1.length > 0) {
        await ebayGetMyMessages('ReturnMessages', messageIDs1, '1');
      }
      // `if ($msgs)` is an Eloquent Collection (always truthy) — the
      // `echo "oops"` branch is dead code in the old app (NOTES.md).
      // SAFETY: rows are full os_messages rows (cont.).
      const msgsHeaders = (await db
        .selectFrom('os_messages')
        .selectAll()
        .orderBy('ReceiveDate', 'desc')
        .limit(50)
        .execute()) as unknown as Record<string, unknown>[];
      const html = await renderToString(req, 'message', { msgs, msgsHeaders });
      reply.type('text/html; charset=UTF-8').send(prefix + html);
    },
  });

  route(app, {
    verb: 'get',
    path: '/reloadAllMsg',
    name: 'reloadAllMsg',
    middleware: MIDDLEWARE,
    handler: async (_req, reply) => {
      const resp = await ebayGetMyMessages('ReturnHeaders');
      if (resp.ack === 'Success') await saveEbayMessages(resp.messages?.[0] ?? null);
      const resp2 = await ebayGetMyMessages('ReturnHeaders', [], '1');
      if (resp2.ack === 'Success') await saveEbayMessages(resp2.messages?.[0] ?? null);
      // The old action returns nothing: empty 200 body.
      reply.type('text/html; charset=UTF-8').send('');
    },
  });
}

async function registerUserMessageController(app: FastifyInstance): Promise<void> {
  route(app, {
    verb: 'get',
    path: '/getUserMsg',
    name: 'getUserMsg',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const userId = (await currentUser(req)).user?.id;
      const uid = (userId ?? 0) as number;
      // SAFETY: rows are full os_user_message rows (handler reads columns only).
      const rows = (await db
        .selectFrom('os_user_message')
        .selectAll()
        // Old SQL copied verbatim (string '0' comparison included).
        // SAFETY: Kysely 0.29 does not accept RawBuilder in where(); runtime is fine.
        .where(sql`(to_user = ${uid} or to_user = '0' or from_user = ${uid}) and (deleted is null or deleted = '0')` as unknown as Expression<never>)
        .orderBy('created_at', 'asc')
        .execute()) as unknown as Record<string, unknown>[];
      reply.send(await withUserRelations(rows, ['from_user', 'to_user']));
    },
  });

  route(app, {
    verb: 'post',
    path: '/flagUserMsg',
    name: 'flagUserMsg',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const msgId = input(req, 'id');
      let readFlag = input(req, 'readFlag');
      if (readFlag === null || readFlag === '') readFlag = 1; // PHP $readFlag==null
      // SAFETY: row is a full os_user_message row (cont. pattern).
      const msg =
        msgId === null || msgId === undefined
          ? null
          : ((await db.selectFrom('os_user_message').selectAll().where('id', '=', Number(msgId)).executeTakeFirst()) as unknown as Record<string, unknown> | null);
      if (msg) {
        const ts = nowDb();
        await db
          .updateTable('os_user_message')
          .set({
            // SAFETY: the form value is the string '0'/'1'; tinyint coerces it.
            hasRead: readFlag as unknown as number,
            // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
            updated_at: ts as unknown as Date,
          })
          .where('id', '=', Number(msgId))
          .execute();
        msg.hasRead = readFlag as number;
        msg.updated_at = ts;
      }
      // SAFETY: executeTakeFirst() returns undefined (not null); emit JSON
      // 'null' like Laravel's json(null) when the row does not exist.
      jsonValue(reply, msg ?? null);
    },
  });

  route(app, {
    verb: 'post',
    path: '/deleteMsg',
    name: 'deleteMsg',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const msgId = input(req, 'id');
      // SAFETY: row is a full os_user_message row (cont. pattern).
      const msg =
        msgId === null || msgId === undefined
          ? null
          : ((await db.selectFrom('os_user_message').selectAll().where('id', '=', Number(msgId)).executeTakeFirst()) as unknown as Record<string, unknown> | null);
      if (msg) {
        const ts = nowDb();
        await db
          .updateTable('os_user_message')
          .set({
            deleted: 1,
            // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
            updated_at: ts as unknown as Date,
          })
          .where('id', '=', Number(msgId))
          .execute();
        msg.deleted = 1;
        msg.updated_at = ts;
      }
      // SAFETY: executeTakeFirst() returns undefined (not null); emit JSON
      // 'null' like Laravel's json(null) when the row does not exist (cont.).
      jsonValue(reply, msg ?? null);
    },
  });

  route(app, {
    verb: 'get',
    path: '/showMessage',
    name: 'showMessage',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const userId = (await currentUser(req)).user?.id;
      const uid = Number(userId ?? 0);
      // SAFETY: rows are full os_user_message rows (cont. pattern).
      const rows = (await db
        .selectFrom('os_user_message')
        .selectAll()
        // Old SQL copied verbatim (string '0' comparison included).
        // SAFETY: Kysely 0.29 does not accept RawBuilder in where(); runtime is fine.
        .where(sql`(to_user = ${uid} or to_user = '0') and (deleted is null or deleted = '0')` as unknown as Expression<never>)
        .orderBy('created_at', 'desc')
        .execute()) as unknown as Record<string, unknown>[];
      // SAFETY: rows are full os_users rows (handler drops $hidden via serializeUser).
      const users = (await db
        .selectFrom('os_users')
        .selectAll()
        .where('id', '!=', uid)
        .execute()) as unknown as Record<string, unknown>[];
      await render(req, reply, 'message/index', {
        messages: await withUserRelations(rows, ['from_user']),
        users: users.map(serializeUser),
      });
    },
  });

  route(app, {
    verb: 'get',
    path: '/showSentMessage',
    name: 'showSentMessage',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const userId = (await currentUser(req)).user?.id;
      // SAFETY: rows are full os_user_message rows (handler reads columns only).
      const rows = (await db
        .selectFrom('os_user_message')
        .selectAll()
        .where('from_user', '=', Number(userId ?? 0))
        .orderBy('created_at', 'desc')
        .execute()) as unknown as Record<string, unknown>[];
      await render(req, reply, 'message/sent', {
        messages: await withUserRelations(rows, ['to_user']),
      });
    },
  });

  route(app, {
    verb: 'post',
    path: '/sendMessage',
    name: 'sendMessage',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      let message = input<string>(req, 'message');
      if (message === null || String(message).length < 1) return jsonValue(reply, 'no message');
      const toUser = input<string>(req, 'to_user');
      if (toUser === null || String(toUser).length < 1) return jsonValue(reply, 'no to user');
      message = String(message).replace(/^\s+|\s+$/g, '');
      const currentTime = nowDb();
      const userId = (await currentUser(req)).user?.id;
      if (eqZero(toUser)) {
        // SAFETY: rows are full os_users rows (cont. pattern).
        const users = (await db
          .selectFrom('os_users')
          .selectAll()
          .where('id', '!=', Number(userId ?? 0))
          .execute()) as unknown as Record<string, unknown>[];
        for (const u of users) {
          await db
            .insertInto('os_user_message')
            .values({
              from_user: userId,
              to_user: Number(u.id),
              message,
              // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
              created_at: currentTime as unknown as Date,
              // SAFETY: nowDb() string (cont.).
              updated_at: currentTime as unknown as Date,
            })
            .executeTakeFirst();
          await trigger('angel-channel', 'message-event', {
            new_message: true,
            from_user: userId,
            to_user: u.id,
            message,
            time: currentTime,
          });
        }
      } else {
        await db
          .updateTable('os_user_message')
          .set({
            // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string (cont.).
            updated_at: currentTime as unknown as Date,
            hasRead: 1,
          })
          .where('from_user', '=', Number(toUser))
          .where('to_user', '=', Number(userId ?? 0))
          // Old SQL copied verbatim (string '0' comparison included).
          .where(
            // SAFETY: Kysely 0.29 does not accept RawBuilder in where(); runtime is fine.
            sql`(hasRead is null or hasRead = '0')` as unknown as Expression<never>,
          )
          .execute();
        await db
          .insertInto('os_user_message')
          .values({
            from_user: userId,
            to_user: Number(toUser),
            message,
            // SAFETY: nowDb() is a 'YYYY-MM-DD HH:mm:ss' string.
            created_at: currentTime as unknown as Date,
            // SAFETY: nowDb() string (cont.).
            updated_at: currentTime as unknown as Date,
          })
          .executeTakeFirst();
        await trigger('angel-channel', 'message-event', {
          new_message: true,
          from_user: userId,
          to_user: Number(toUser),
          message,
          time: currentTime,
        });
      }
      jsonValue(reply, 'sent');
    },
  });

  any(app, {
    path: '/getUserList',
    name: 'getUserList',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      const userId = (await currentUser(req)).user?.id;
      // SAFETY: rows are full os_users rows (cont. pattern).
      const users = (await db
        .selectFrom('os_users')
        .selectAll()
        .where('id', '!=', Number(userId ?? 0))
        .execute()) as unknown as Record<string, unknown>[];
      reply.send(users.map(serializeUser));
    },
  });

  any(app, {
    path: '/messageFileUpload',
    name: 'messageFileUpload',
    middleware: MIDDLEWARE,
    handler: async (req, reply) => {
      // Laravel $request->file('chatfileupload'): the uploaded file part(s).
      for await (const part of req.files()) {
        const file = part as { fieldname: string; filename: string; toBuffer: () => Promise<Buffer> };
        if (file.fieldname !== 'chatfileupload') continue;
        const buf = await file.toBuffer();
        const img = await image(buf).widen(1000, (c) => c.upsize()).stream();
        const filePath = file.filename;
        const chat = disk('chat');
        await chat.put(filePath, img);
        if (await chat.exists(filePath)) return jsonValue(reply, filePath);
      }
      jsonValue(reply, 'oops');
    },
  });
}

export function registerMessageRoutes(app: FastifyInstance): void {
  void registerMessageController(app);
  void registerUserMessageController(app);
}
