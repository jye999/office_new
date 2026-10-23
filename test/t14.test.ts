// T14: ChatController (/chat, /chat/send, /chat/transcribe) +
// GptController (/generateDescription).
// External seams: OpenAI (setOpenAiPostForTests, setChatTranscribeFetchForTests)
// and MCP (setMcpFetchForTests) are stubbed so no live call leaves the box.

import fastifyMultipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { registerHttpHelpers } from '../src/http.js';
import { setOpenAiPostForTests } from '../src/lib/chatService.js';
import { setMcpFetchForTests } from '../src/lib/mcp.js';
import { registerChatRoutes, setChatTranscribeFetchForTests } from '../src/modules/chat/routes.js';
import { registerGptRoutes } from '../src/modules/gpt/routes.js';
import { db } from '../src/db.js';
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

function buildApp(user: { id: number } | null) {
  const app = Fastify();
  void app.register(formbody);
  void app.register(fastifyMultipart);
  void app.register(registerHttpHelpers);
  void registerViewPlugins(app);
  registerChatRoutes(app);
  registerGptRoutes(app);
  app.addHook('preHandler', async (req) => {
    if (user) (req.session as Record<string, unknown>)['user_id'] = user.id;
  });
  return app;
}

// JSON-RPC response helper for the MCP fetch stub.
function mcpJsonRpc(id: number, result: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// MCP server stub: initialize ok, tools/list with one tool, tools/call echoes.
function stubMcp(calls: { method: string; params?: AnyRecord }[]) {
  setMcpFetchForTests(async (url, init) => {
    const body = JSON.parse(String(init.body)) as { method: string; id: number; params?: AnyRecord };
    calls.push({ method: body.method, params: body.params });
    if (body.method === 'initialize') return mcpJsonRpc(body.id, {}, { 'Mcp-Session-Id': 'sess-1' });
    if (body.method === 'tools/list') {
      return mcpJsonRpc(body.id, {
        tools: [{ name: 'get_sku', description: 'Look up a SKU', inputSchema: { type: 'object', properties: { sku: { type: 'string' } } } }],
      });
    }
    if (body.method === 'tools/call') {
      const args = (body.params?.arguments ?? {}) as { sku?: string };
      return mcpJsonRpc(body.id, { content: [{ type: 'text', text: `SKU ${args.sku} found` }] });
    }
    throw new Error(`unexpected MCP method ${body.method}`);
  });
}

describe('T14 chat / gpt (fastify inject)', () => {
  beforeEach(() => {
    setMcpFetchForTests(null);
    setOpenAiPostForTests(null);
    setChatTranscribeFetchForTests(null);
  });

  afterAll(async () => {
    setMcpFetchForTests(null);
    setOpenAiPostForTests(null);
    setChatTranscribeFetchForTests(null);
    await db.destroy();
  });

  it('role guards: anon -> 302 /login on all four routes', async () => {
    const app = buildApp(null);
    for (const [method, url] of [
      ['GET', '/chat'],
      ['GET', '/generateDescription'],
      ['POST', '/chat/send'],
      ['POST', '/chat/transcribe'],
    ]) {
      const out = await app.inject({ method, url });
      expect(out.statusCode).toBe(302);
      expect(out.headers['location']).toBe('http://localhost:80/login');
    }
    await app.close();
  });

  it('GET /chat: renders the standalone page with the chat.send/transcribe URLs', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/chat' });
    expect(out.statusCode).toBe(200);
    expect(out.headers['content-type']).toContain('text/html');
    expect(out.body).toContain('<title>Inventory AI Assistant</title>');
    expect(out.body).toContain('id="mic-btn"');
    expect(out.body).toContain(`${config.APP_URL}/chat/send`);
    expect(out.body).toContain(`${config.APP_URL}/chat/transcribe`);
    // csrf_token() emitted where the Blade {{ csrf_token() }} was
    expect(out.body).toContain('meta name="csrf-token"');
    await app.close();
  });

  it('GET /generateDescription: renders the literal <x-app-layout> view (no Blade 5.4 component support, as old app)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    const out = await app.inject({ method: 'GET', url: '/generateDescription' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('Assisant');
    expect(out.body).toContain('<x-app-layout>');
    expect(out.body).toContain('id="productDescription"');
    await app.close();
  });

  it('POST /chat/send: validation failures -> 422 Laravel JSON shape', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    let out = await app.inject({
      method: 'POST',
      url: '/chat/send',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      message: 'The message field is required.',
      errors: { message: ['The message field is required.'] },
    });

    out = await app.inject({
      method: 'POST',
      url: '/chat/send',
      headers: { 'content-type': 'application/json' },
      payload: { message: 'x', history: 'not-an-array' },
    });
    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      message: 'The history field must be an array.',
      errors: { history: ['The history field must be an array.'] },
    });

    out = await app.inject({
      method: 'POST',
      url: '/chat/send',
      headers: { 'content-type': 'application/json' },
      payload: { message: 'x'.repeat(2001) },
    });
    expect(JSON.parse(out.body)).toMatchObject({
      errors: { message: ['The message may not be greater than 2000 characters.'] },
    });
    await app.close();
  });

  it('POST /chat/send: tool-calling loop round-trips through (stubbed) MCP + OpenAI', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const mcpCalls: { method: string; params?: AnyRecord }[] = [];
    stubMcp(mcpCalls);
    const openAiBodies: AnyRecord[] = [];
    let round = 0;
    setOpenAiPostForTests(async (jsonBody) => {
      const body = JSON.parse(jsonBody) as AnyRecord;
      openAiBodies.push(body);
      round++;
      if (round === 1) {
        return {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', function: { name: 'get_sku', arguments: JSON.stringify({ sku: 'R020WY' }) } }],
              },
            },
          ],
        };
      }
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Found it at **A1**.' } }] };
    });

    const app = buildApp(admin);
    const out = await app.inject({
      method: 'POST',
      url: '/chat/send',
      headers: { 'content-type': 'application/json' },
      payload: { message: 'Where is R020WY', history: [] },
    });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as { success: boolean; reply: string; history: AnyRecord[] };
    expect(body.success).toBe(true);
    expect(body.reply).toBe('Found it at **A1**.');
    // history: system, user, assistant(tool_calls), tool, assistant
    expect(body.history.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(String(body.history[1].content)).toBe('Where is R020WY');
    expect(body.history[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'SKU R020WY found' });
    expect(body.history[4]).toEqual({ role: 'assistant', content: 'Found it at **A1**.' });
    expect(body.history[0].content).toContain('Inventory Management AI Assistant');
    // OpenAI payload: model + tool_choice auto on round 1, tool list present
    expect(openAiBodies[0].tool_choice).toBe('auto');
    expect((openAiBodies[0].tools as AnyRecord[])[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_sku',
        description: 'Look up a SKU',
        parameters: { type: 'object', properties: { sku: { type: 'string' } } },
      },
    });
    expect(openAiBodies[0].model).toBe(config.OPENAI_MODEL);
    // MCP: initialize, tools/list, tools/call (no re-initialize on call)
    expect(mcpCalls.map((c) => c.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
    expect(mcpCalls[2].params).toEqual({ name: 'get_sku', arguments: { sku: 'R020WY' } });
    await app.close();
  });

  it('POST /chat/send: existing history with a system prompt is not duplicated', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    stubMcp([]);
    setOpenAiPostForTests(async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
    const app = buildApp(admin);
    const out = await app.inject({
      method: 'POST',
      url: '/chat/send',
      headers: { 'content-type': 'application/json' },
      payload: {
        message: 'again',
        history: [{ role: 'system', content: 'my own system' }, { role: 'user', content: 'first' }],
      },
    });
    const body = JSON.parse(out.body) as { history: AnyRecord[] };
    expect(body.history.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant']);
    expect(body.history[0].content).toBe('my own system');
    await app.close();
  });

  it('POST /chat/send: OpenAI failure -> 500 with the fixed apology (error detail only in local env)', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    stubMcp([]);
    setOpenAiPostForTests(async () => {
      throw new Error('OpenAI API request failed: 401 bad key');
    });
    const app = buildApp(admin);
    const out = await app.inject({
      method: 'POST',
      url: '/chat/send',
      headers: { 'content-type': 'application/json' },
      payload: { message: 'hi' },
    });
    expect(out.statusCode).toBe(500);
    const body = JSON.parse(out.body) as AnyRecord;
    expect(body).toEqual({
      success: false,
      reply: 'Sorry, something went wrong processing your request. Please try again.',
      error: config.APP_ENV === 'local' ? 'OpenAI API request failed: 401 bad key' : null,
    });
    await app.close();
  });

  it('POST /chat/transcribe: missing file -> 422; audio -> multipart to OpenAI, JSON reply', async () => {
    const admin = await userWithRole(['admin']);
    if (!admin) throw new Error('no admin user in DB');
    const app = buildApp(admin);
    // No file at all
    let out = await app.inject({
      method: 'POST',
      url: '/chat/transcribe',
      headers: { 'content-type': 'multipart/form-data; boundary=B' },
      payload: '--B\r\n--B--\r\n',
    });
    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      message: 'The audio field is required.',
      errors: { audio: ['The audio field is required.'] },
    });

    let seen: { url: string; headers: Record<string, string>; body: Buffer } | null = null;
    setChatTranscribeFetchForTests(async (init) => {
      seen = init;
      return { ok: true, text: JSON.stringify({ text: '  hello world  ' }) };
    });
    const boundary = 'T14BOUNDARY';
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([header, Buffer.from('RIFF'), footer]);
    out = await app.inject({
      method: 'POST',
      url: '/chat/transcribe',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ success: true, text: 'hello world' });
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(seen!.headers['Authorization']).toMatch(/^Bearer /);
    const raw = seen!.body.toString('latin1');
    expect(raw).toContain('filename="audio.wav"');
    expect(raw).toContain(`name="model"\r\n\r\n${config.OPENAI_TRANSCRIPTION_MODEL}`);
    expect(raw).toContain('name="response_format"\r\n\r\njson');
    expect(raw).toContain('RIFF');

    // Empty transcript -> success false
    setChatTranscribeFetchForTests(async () => ({ ok: true, text: JSON.stringify({ text: '   ' }) }));
    out = await app.inject({
      method: 'POST',
      url: '/chat/transcribe',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(JSON.parse(out.body)).toEqual({ success: false, text: '' });

    // Upstream failure -> 500 JSON
    setChatTranscribeFetchForTests(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    out = await app.inject({
      method: 'POST',
      url: '/chat/transcribe',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body)).toEqual({
      success: false,
      text: '',
      error: config.APP_ENV === 'local' ? 'connect ETIMEDOUT' : 'Transcription failed',
    });
    setChatTranscribeFetchForTests(null);
    await app.close();
  });

  it('McpClient: SSE responses parsed from the last data: line; session id reused', async () => {
    const { McpClient } = await import('../src/lib/mcp.js');
    const seenHeaders: (string | null)[] = [];
    let id = 0;
    setMcpFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      id++;
      seenHeaders.push((init.headers as Record<string, string>)['Mcp-Session-Id'] ?? null);
      if (body.method === 'initialize') {
        return new Response(
          'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess-42' } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new McpClient();
    const tools = await client.listTools();
    expect(tools).toHaveLength(0); // stub's tools/list has no result.tools -> []
    const res = await client.callTool('x', {});
    expect(res).toEqual({ ok: true });
    // first request (initialize) has no session header; later requests carry it
    expect(seenHeaders).toEqual([null, 'sess-42', 'sess-42']);
    // toOpenAiTools default schema for missing inputSchema/description
    expect(client.toOpenAiTools([{ name: 'n' }])).toEqual([
      { type: 'function', function: { name: 'n', description: '', parameters: { type: 'object', properties: {} } } },
    ]);
    setMcpFetchForTests(null);
  });
});
