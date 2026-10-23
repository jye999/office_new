// T13: MessageController (/msg, /reloadAllMsg) + UserMessageController
// (/getUserMsg, /flagUserMsg, /deleteMsg, /showMessage, /showSentMessage,
// /sendMessage, /getUserList, /messageFileUpload).
// External seams: eBay (setEbayGetMyMessagesForTests) and Pusher
// (setPusherClientForTests) are stubbed so no live call leaves the box.
// DB writes are insert-then-cleanup (T12 pattern) or restore-to-original.

import fastifyMultipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import sharp from 'sharp';
import { rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Expression } from 'kysely';
import { setEbayGetMyMessagesForTests } from '../src/lib/ebay.js';
import { db, sql } from '../src/db.js';
import { registerHttpHelpers } from '../src/http.js';
import { setPusherClientForTests } from '../src/pusher.js';
import { registerMessageRoutes } from '../src/modules/message/routes.js';
import { registerViewPlugins } from '../src/view.js';

type AnyRecord = Record<string, unknown>;

function userWithRole(roles: string[]) {
  return db
    .selectFrom('os_users')
    .innerJoin('os_user_has_roles', 'os_user_has_roles.user_id', 'os_users.id')
    .innerJoin('os_roles', 'os_roles.id', 'os_user_has_roles.role_id')
    .select(['os_users.id'])
    .where('os_roles.name', 'in', roles)
    .executeTakeFirst();
}

let pusherEvents: { channel: string; event: string; data: AnyRecord }[] = [];

function buildApp(user: { id: number } | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(fastifyMultipart);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerMessageRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

const TEST_PREFIX = 't13test_';
const STAMP = `${Date.now()}`;

describe('T13 message / usermessage (fastify inject)', () => {
  beforeEach(() => {
    pusherEvents = [];
    setPusherClientForTests({
      trigger: async (channel: string, event: string, data: AnyRecord) => {
        pusherEvents.push({ channel, event, data });
      },
    } as never);
  });

  afterAll(async () => {
    setPusherClientForTests(null);
    await db.destroy();
  });

  it('role guards: anon -> 302 /login, supplier -> 403 No Access.', async () => {
    const anon = buildApp(null);
    let out = await anon.inject({ method: 'GET', url: '/getUserMsg' });
    expect(out.statusCode).toBe(302);
    expect(out.headers['location']).toBe('http://localhost:80/login');
    await anon.close();

    const supplier = await userWithRole(['supplier']);
    if (supplier) {
      const app = buildApp(supplier);
      out = await app.inject({ method: 'GET', url: '/showMessage' });
      expect(out.statusCode).toBe(403);
      expect(out.body).toBe('No Access.');
      await app.close();
    }
  });

  it('GET /getUserMsg: JSON matches a direct read; relations replace the scalar from_user/to_user columns in place', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/getUserMsg' });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as AnyRecord[];

    // Independent read: same where/order as the handler.
    // SAFETY: same raw-SQL where as the handler (Kysely 0.29 factory types).
    const rows = (await db
      .selectFrom('os_user_message')
      .selectAll()
      .where(
        sql`(to_user = ${admin.id} or to_user = '0' or from_user = ${admin.id}) and (deleted is null or deleted = '0')` as unknown as Expression<never>,
      )
      .orderBy('created_at', 'asc')
      .execute()) as unknown as AnyRecord[];
    expect(body.length).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) {
      // Laravel inlines the loaded relations at the lowercase column keys.
      expect(Object.keys(body[i])).toEqual([
        'id',
        'created_at',
        'updated_at',
        'from_user',
        'to_user',
        'message',
        'hasRead',
        'deleted',
      ]);
      for (const k of ['id', 'created_at', 'updated_at', 'message', 'hasRead', 'deleted'] as const) {
        expect(body[i][k]).toEqual(rows[i][k]);
      }
      if (rows[i].from_user === null) expect(body[i].from_user).toBeNull();
      if (rows[i].to_user === null) expect(body[i].to_user).toBeNull();
    }
    await app.close();
  });

  it('GET /showMessage + /showSentMessage: render the layout pages', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/showMessage' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('id="messages"');
    expect(out.body).toContain('btnWrite');
    expect(out.body).toContain('flagUserMsg');
    expect(out.body).toContain('sendMessage');

    out = await app.inject({ method: 'GET', url: '/showSentMessage' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('Messages Received');
    expect(out.body).toContain('deleteLink');
    await app.close();
  });

  it('GET /getUserList: other users, password/remember_token hidden', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/getUserList' });
    expect(out.statusCode).toBe(200);
    const users = JSON.parse(out.body) as AnyRecord[];
    const all = (await db.selectFrom('os_users').selectAll().execute()) as unknown as AnyRecord[];
    expect(users.length).toBe(all.filter((u) => u.id !== admin.id).length);
    for (const u of users) {
      expect(u).not.toHaveProperty('password');
      expect(u).not.toHaveProperty('remember_token');
      expect(Object.keys(u)[0]).toBe('id');
    }
    await app.close();
  });

  it('GET /msg: batches of 9 hit the (stubbed) eBay inbox, page renders rows', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const ebayCalls: { detail: string; msgIds: string[]; folderId: string }[] = [];
    // Copy msgIds: the handler reuses/reset one array in place, so the live
    // reference captured at call time would mutate with later batches.
    setEbayGetMyMessagesForTests(async (c) => {
      ebayCalls.push({ detail: c.detail, msgIds: [...c.msgIds], folderId: c.folderId });
      return { ack: 'Success', messages: [] };
    });
    const created: string[] = [];
    // PHP splits on RecipientUserID == 'bridalfavor': i>=8 -> bucket0 (folder
    // '0'; its trailing batch fires print_r), i<8 -> bucket1 (folder '1').
    for (let i = 0; i < 10; i++) {
      const res = await db
        .insertInto('os_messages')
        .values({
          MessageID: `${TEST_PREFIX}m${STAMP}${i}`,
          Sender: TEST_PREFIX,
          // SAFETY: date columns store 'YYYY-MM-DD' strings; distinct per row
          // so ReceiveDate DESC is deterministic (i=9 first, i=0 last).
          ReceiveDate: `2024-01-0${i + 1}` as unknown as Date,
          // SAFETY: NOT NULL tinyints.
          Read: 0,
          Flagged: 0,
          Replied: 0,
          Subject: `t13 subj ${i}`,
          // SAFETY: date columns store 'YYYY-MM-DD' strings (cont.).
          updated_at: '2024-01-01' as unknown as Date,
          created_at: '2024-01-01' as unknown as Date,
          RecipientUserID: i < 8 ? 't13user' : 'bridalfavor',
          MessageType: 'Feedback',
        })
        .executeTakeFirst();
      created.push(`${TEST_PREFIX}m${STAMP}${i}`);
      void res;
    }
    try {
      const app = buildApp(admin);
      const out = await app.inject({ method: 'GET', url: `/msg?user=${TEST_PREFIX}` });
      expect(out.statusCode).toBe(200);
      expect(out.body).toContain('Messages</title>');
      expect(out.body).toContain(`t13 subj 9`);
      // ReceiveDate desc: i=9..0; bucket0 (bridalfavor) = i 9, 8; bucket1 = i 7..0.
      expect(ebayCalls, JSON.stringify(ebayCalls)).toEqual([
        { detail: 'ReturnMessages', msgIds: [`${TEST_PREFIX}m${STAMP}9`, `${TEST_PREFIX}m${STAMP}8`], folderId: '0' },
        { detail: 'ReturnMessages', msgIds: Array.from({ length: 8 }, (_, i) => `${TEST_PREFIX}m${STAMP}${7 - i}`), folderId: '1' },
      ]);
      // bucket0 tail: sizeof(first Message)>1 is false -> print_r(empty Messages node).
      expect(out.body.startsWith('Messages: SimpleXMLElement Object\n(\n)\n')).toBe(true);
      await app.close();
    } finally {
      for (const id of created) await db.deleteFrom('os_messages').where('MessageID', '=', id).execute();
      setEbayGetMyMessagesForTests(null);
    }
  });

  it('GET /reloadAllMsg: empty inbox -> 200 empty; non-empty inbox -> 500 (strict-mode insert, as old app)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    setEbayGetMyMessagesForTests(async () => ({ ack: 'Success', messages: [] }));
    let app = buildApp(admin);
    let out = await app.inject({ method: 'GET', url: '/reloadAllMsg' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe('');
    await app.close();

    // A single <Message> with children -> saveMessage() inserts all-null rows -> strict MySQL rejects.
    setEbayGetMyMessagesForTests(async () => ({
      ack: 'Success',
      messages: [{ MessageID: '123', Sender: 'x', RecipientUserID: 'y' }],
    }));
    app = buildApp(admin);
    out = await app.inject({ method: 'GET', url: '/reloadAllMsg' });
    expect(out.statusCode).toBe(500);
    // No rows may have appeared.
    const stray = await db.selectFrom('os_messages').select('MessageID').where('MessageID', 'like', `${TEST_PREFIX}%`).execute();
    expect(stray).toHaveLength(0);
    await app.close();
    setEbayGetMyMessagesForTests(null);
  });

  it('POST /flagUserMsg: toggles hasRead + updated_at, returns the row (missing id -> null)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const before = (await db.selectFrom('os_user_message').selectAll().orderBy('id', 'desc').limit(1).executeTakeFirst()) as unknown as AnyRecord | null;
    const app = buildApp(admin);
    if (before) {
      const out = await app.inject({ method: 'POST', url: '/flagUserMsg', payload: { id: before.id, readFlag: '0' } });
      expect(out.statusCode).toBe(200);
      const body = JSON.parse(out.body) as AnyRecord;
      expect(body.id).toBe(before.id);
      expect(Number(body.hasRead)).toBe(0);
      // restore original state
      const res = await db
        .updateTable('os_user_message')
        .set({
          hasRead: before.hasRead as number,
          // SAFETY: restore the original 'YYYY-MM-DD HH:mm:ss' string.
          updated_at: before.updated_at as unknown as Date,
        })
        .where('id', '=', Number(before.id))
        .execute();
      void res;
      const restored = (await db.selectFrom('os_user_message').selectAll().where('id', '=', Number(before.id)).executeTakeFirst()) as unknown as AnyRecord;
      expect(restored.hasRead).toBe(before.hasRead);
      expect(restored.updated_at).toBe(before.updated_at);
    }
    const missing = await app.inject({ method: 'POST', url: '/flagUserMsg', payload: { id: 999999999 } });
    expect(missing.statusCode).toBe(200);
    expect(missing.body).toBe('null');
    await app.close();
  });

  it('POST /deleteMsg: soft-deletes (insert -> delete -> cleanup)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const res = await db
      .insertInto('os_user_message')
      .values({
        from_user: admin.id,
        to_user: 0,
        message: `${TEST_PREFIX}del ${STAMP}`,
        // SAFETY: timestamp columns store 'YYYY-MM-DD HH:mm:ss' strings.
        created_at: '2024-01-01 00:00:00' as unknown as Date,
        updated_at: '2024-01-01 00:00:00' as unknown as Date,
      })
      .executeTakeFirst();
    const id = Number(res.insertId);
    try {
      const app = buildApp(admin);
      const out = await app.inject({ method: 'POST', url: '/deleteMsg', payload: { id } });
      expect(out.statusCode).toBe(200);
      const body = JSON.parse(out.body) as AnyRecord;
      expect(body.id).toBe(id);
      expect(Number(body.deleted)).toBe(1);
      // deleted rows are filtered out of /getUserMsg
      const list = await app.inject({ method: 'GET', url: '/getUserMsg' });
      const rows = JSON.parse(list.body) as AnyRecord[];
      expect(rows.some((r) => r.id === id)).toBe(false);
      await app.close();
    } finally {
      await db.deleteFrom('os_user_message').where('id', '=', id).execute();
    }
  });

  it('POST /sendMessage: validation, broadcast + direct branches (stubbed pusher)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({ method: 'POST', url: '/sendMessage', payload: { to_user: '0' } });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe('"no message"');
    out = await app.inject({ method: 'POST', url: '/sendMessage', payload: { message: 'hi' } });
    expect(out.body).toBe('"no to user"');

    const userCount = (await db.selectFrom('os_users').select('id').execute()).length;
    const mark = `${TEST_PREFIX}sent${STAMP}`;
    out = await app.inject({ method: 'POST', url: '/sendMessage', payload: { to_user: '0', message: `  ${mark}  ` } });
    expect(out.body).toBe('"sent"');
    expect(pusherEvents).toHaveLength(userCount - 1);
    expect(pusherEvents[0].channel).toBe('angel-channel');
    expect(pusherEvents[0].event).toBe('message-event');
    expect(pusherEvents[0].data).toMatchObject({ new_message: true, from_user: admin.id, message: mark });

    // direct branch: marks the counterpart's unread rows read + inserts
    const other = (await db.selectFrom('os_users').selectAll().where('id', '!=', admin.id).limit(1).executeTakeFirst()) as unknown as AnyRecord;
    out = await app.inject({ method: 'POST', url: '/sendMessage', payload: { to_user: String(other.id), message: mark } });
    expect(out.body).toBe('"sent"');
    const inserted = (await db
      .selectFrom('os_user_message')
      .selectAll()
      .where('message', '=', mark)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()) as unknown as AnyRecord;
    expect(inserted.from_user).toBe(admin.id);
    expect(inserted.to_user).toBe(other.id);
    // cleanup all rows this test created
    await db.deleteFrom('os_user_message').where('message', '=', mark).execute();
    await app.close();
  });

  it('any /messageFileUpload: no file -> "oops"; a small PNG -> widened/stored, returns the filename', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    // No file: an (empty) multipart body — same as a form with no file selected.
    let out = await app.inject({
      method: 'POST',
      url: '/messageFileUpload',
      headers: { 'content-type': 'multipart/form-data; boundary=B' },
      payload: '--B\r\n--B--\r\n',
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe('"oops"');

    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const name = `${TEST_PREFIX}file${STAMP}.png`;
    out = await app.inject({
      method: 'POST',
      url: '/messageFileUpload',
      headers: { 'content-type': 'multipart/form-data; boundary=BOUNDARY' },
      payload: `--BOUNDARY\r\nContent-Disposition: form-data; name="chatfileupload"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`,
    });
    // inject() needs the raw binary after the header block; build the body manually:
    void out;
    const boundary = 'BOUNDARY';
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chatfileupload"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, png, footer]);
    const out2 = await app.inject({
      method: 'POST',
      url: '/messageFileUpload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      },
      payload: body,
    });
    expect(out2.statusCode).toBe(200);
    expect(out2.body).toBe(JSON.stringify(name));
    // cleanup the uploaded file (shared storage dir — old app's public/chat)
    const storageDir = process.env.STORAGE_DIR ?? '/home/johnny/code/office/storage';
    rmSync(`${storageDir}/app/public/chat/${name}`, { force: true });
    await app.close();
  });
});
