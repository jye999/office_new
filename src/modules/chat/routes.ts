// ChatController (/chat, /chat/send, /chat/transcribe).
// `auth` middleware from the controller constructor — no roles.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { route } from '../../router.js';
import { render } from '../../view.js';
import { input } from '../../http.js';
import { config } from '../../config.js';
import { ChatService, setOpenAiPostForTests } from '../../lib/chatService.js';
import { McpClient } from '../../lib/mcp.js';

type AnyRecord = Record<string, unknown>;

// response()->json(x) — JSON content type even for values Fastify would send
// as text (same note as T13's jsonValue).
function jsonValue(reply: FastifyReply, value: unknown, status = 200): void {
  reply.code(status).type('application/json; charset=utf-8').send(JSON.stringify(value));
}

// safeJsonResponse(): JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE —
// JSON.stringify matches (never escapes non-ASCII; JS strings are valid UTF-16).
function safeJsonResponse(reply: FastifyReply, data: unknown, status = 200): void {
  jsonValue(reply, data, status);
}

// Laravel validation for JSON/Accept-json requests: 422 +
// { message: <first error>, errors: { field: [msgs] } }.
function validationError(reply: FastifyReply, errors: Record<string, string[]>): void {
  const first = Object.values(errors)[0]?.[0] ?? '';
  jsonValue(reply, { message: first, errors }, 422);
}

// Test seam for the OpenAI transcriptions POST (multipart) so unit tests
// never reach api.openai.com.
type TranscribeFetch = (init: { url: string; headers: Record<string, string>; body: Buffer }) => Promise<{ ok: boolean; text: string }>;

let transcribeFetchImpl: TranscribeFetch = async (init) => {
  const res = await fetch(init.url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
  });
  return { ok: res.ok, text: await res.text() };
};

export function setChatTranscribeFetchForTests(fn: TranscribeFetch | null): void {
  transcribeFetchImpl =
    fn ??
    ((init) => {
      const f = async (i: { url: string; headers: Record<string, string>; body: Buffer }) => {
        const res = await fetch(i.url, { method: 'POST', headers: i.headers, body: i.body });
        return { ok: res.ok, text: await res.text() };
      };
      return f(init);
    });
}

async function registerChatController(app: FastifyInstance): Promise<void> {
  route(app, {
    verb: 'get',
    path: '/chat',
    name: 'chat',
    middleware: ['web'],
    handler: async (req, reply) => {
      await render(req, reply, 'chat');
    },
  });

  route(app, {
    verb: 'post',
    path: '/chat/send',
    name: 'chat.send',
    middleware: ['web'],
    handler: async (req, reply) => {
      const message = input(req, 'message');
      const history = input<unknown>(req, 'history');

      // $this->validate($request, ['message' => 'required|string|max:2000',
      //                           'history' => 'nullable|array']);
      const errors: Record<string, string[]> = {};
      if (message === null || message === undefined || String(message) === '') {
        errors.message = ['The message field is required.'];
      } else {
        // required|string|max:2000, in rule order. (PHP treats numerics as strings.)
        if (typeof message !== 'string' && typeof message !== 'number') {
          errors.message = ['The message field must be a string.'];
        } else if (String(message).length > 2000) {
          errors.message = ['The message may not be greater than 2000 characters.'];
        }
      }
      if (history !== null && history !== undefined && history !== '' && !Array.isArray(history)) {
        errors.history = ['The history field must be an array.'];
      }
      if (Object.keys(errors).length > 0) return validationError(reply, errors);

      const userMessage = String(message);
      const historyArr = Array.isArray(history) ? (history as AnyRecord[]) : [];

      try {
        const mcpClient = new McpClient();
        const chatService = new ChatService(mcpClient);
        const result = await chatService.chat(userMessage, historyArr);

        safeJsonResponse(reply, {
          success: true,
          reply: result.reply,
          history: result.history,
        });
      } catch (e) {
        console.error('Chat request failed', {
          message: userMessage,
          error: (e as Error).message,
        });
        jsonValue(
          reply,
          {
            success: false,
            reply: 'Sorry, something went wrong processing your request. Please try again.',
            error: config.APP_ENV === 'local' ? (e as Error).message : null,
          },
          500,
        );
      }
    },
  });

  route(app, {
    verb: 'post',
    path: '/chat/transcribe',
    name: 'chat.transcribe',
    middleware: ['web'],
    handler: async (req, reply) => {
      // audio: required|file|max:25600 (KB).
      let audio: { filename: string; buffer: Buffer } | null = null;
      for await (const part of req.files()) {
        const file = part as { fieldname: string; filename: string; toBuffer: () => Promise<Buffer> };
        if (file.fieldname !== 'audio') continue;
        audio = { filename: file.filename, buffer: await file.toBuffer() };
        break;
      }
      const errors: Record<string, string[]> = {};
      if (!audio) {
        errors.audio = ['The audio field is required.'];
      } else if (audio.buffer.length / 1024 > 25600) {
        errors.audio = ['The audio may not be greater than 25600 kilobytes.'];
      }
      if (Object.keys(errors).length > 0) return validationError(reply, errors);

      const file = audio as { filename: string; buffer: Buffer };
      const extMatch = /\.([^.]+)$/.exec(file.filename);
      const extension = extMatch?.[1] || 'webm'; // clientOriginalExtension ?: 'webm'

      try {
        // Guzzle multipart POST to OpenAI (timeout 60).
        const boundary = `----formboundary${Date.now().toString(16)}`;
        const parts: Buffer[] = [];
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${extension}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ));
        parts.push(file.buffer);
        parts.push(Buffer.from(`\r\n`));
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${process.env.OPENAI_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe'}\r\n`,
        ));
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`,
        ));
        const body = Buffer.concat(parts);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        let result: { ok: boolean; text: string };
        try {
          result = await transcribeFetchImpl({
            url: 'https://api.openai.com/v1/audio/transcriptions',
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!result.ok) throw new Error(`OpenAI transcriptions responded ${result.ok ? 'ok' : 'non-2xx'}`);

        let data: { text?: string } | null = null;
        try {
          data = JSON.parse(result.text) as { text?: string };
        } catch {
          data = null; // json_decode -> null
        }
        const text = data && typeof data.text === 'string' ? data.text.trim() : '';

        console.log('Transcription result', {
          extension,
          file_size: file.buffer.length,
          text,
        });

        jsonValue(reply, { success: text.length > 0, text });
      } catch (e) {
        console.error('Transcription failed', {
          error: (e as Error).message,
          extension,
          file_size: file.buffer.length,
        });
        jsonValue(
          reply,
          {
            success: false,
            text: '',
            error: config.APP_ENV === 'local' ? (e as Error).message : 'Transcription failed',
          },
          500,
        );
      }
    },
  });
}

export function registerChatRoutes(app: FastifyInstance): void {
  void registerChatController(app);
}

// Re-exported so tests can also stub the chat completions seam from one place.
export { setOpenAiPostForTests };
