// Port of the old app's App\Services\McpClient (JSON-RPC 2.0 client for the
// n8n MCP server; handles both plain JSON and SSE responses).

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let mcpFetchImpl: FetchLike = globalThis.fetch as FetchLike;

// Test seam so unit tests never reach the MCP server.
export function setMcpFetchForTests(fn: FetchLike | null): void {
  mcpFetchImpl = fn ?? (globalThis.fetch as FetchLike);
}

export class McpClient {
  private url: string;
  private sessionId: string | null = null;
  private requestId = 0;

  constructor() {
    this.url = process.env.N8N_MCP_URL ?? '';
  }

  private nextId(): number {
    return ++this.requestId;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  // JSON-RPC 2.0 request; parses both plain JSON and SSE (text/event-stream)
  // content types, like the Guzzle client did.
  private async sendRequest(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: this.nextId(),
      method,
    };
    if (Object.keys(params).length > 0) body.params = params;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // Guzzle timeout 30
    let res: Response;
    try {
      res = await mcpFetchImpl(this.url, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...this.buildHeaders(),
        },
      });
    } catch (e) {
      console.error('MCP request failed', { method, error: (e as Error).message });
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const sessionHeader = res.headers.get('Mcp-Session-Id');
    if (sessionHeader) this.sessionId = sessionHeader;

    const contentType = res.headers.get('Content-Type') ?? '';
    const raw = await res.text();

    if (contentType.includes('text/event-stream')) {
      const parsed = this.parseSseResponse(raw);
      if (parsed) return parsed;
      throw new Error(`MCP SSE response had no data: ${raw}`);
    }

    const json = JSON.parse(raw) as Record<string, unknown>;
    // json_decode(..., true) returns null on malformed JSON; PHP callers hit
    // PHP notice/TypeError on the missing keys. JS throws here — same class
    // of failure, caught by ChatService::chat's catch.
    if (json === null || json === undefined) throw new Error(`MCP response was not JSON: ${raw}`);
    return json;
  }

  // Last `data: ` line of the SSE stream, decoded.
  private parseSseResponse(raw: string): Record<string, unknown> | null {
    let lastData: string | null = null;
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (l.startsWith('data: ')) lastData = l.slice(6);
    }
    if (lastData) return JSON.parse(lastData) as Record<string, unknown>;
    return null;
  }

  // JSON round-trip sanitiser (PHP JSON_INVALID_UTF8_SUBSTITUTE). JS strings
  // are already valid UTF-16 with U+FFFD substituted during decoding, so this
  // is a faithful no-op kept for parity.
  private sanitizeUtf8<T>(data: T): T {
    const json = JSON.stringify(data);
    return JSON.parse(json) as T;
  }

  initialize(): Promise<Record<string, unknown>> {
    return this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {}, // PHP `new \stdClass()` -> {} in JSON
      clientInfo: { name: 'office-chat', version: '1.0.0' },
    });
  }

  async listTools(): Promise<Record<string, unknown>[]> {
    await this.initialize();
    const response = await this.sendRequest('tools/list');
    const result = response.result as { tools?: unknown } | undefined;
    if (result && Array.isArray(result.tools)) {
      return this.sanitizeUtf8(result.tools as Record<string, unknown>[]);
    }
    return [];
  }

  async callTool(name: string, arguments_: Record<string, unknown> = {}): Promise<unknown> {
    const response = await this.sendRequest('tools/call', {
      name,
      // PHP: empty arguments -> new \stdClass() -> JSON {} (not null).
      arguments: Object.keys(arguments_).length > 0 ? arguments_ : {},
    });
    if (response.result !== undefined && response.result !== null) {
      return this.sanitizeUtf8(response.result);
    }
    return this.sanitizeUtf8(response);
  }

  // MCP tool definitions -> OpenAI function-tool format.
  toOpenAiTools(mcpTools: Record<string, unknown>[]): Record<string, unknown>[] {
    const tools: Record<string, unknown>[] = [];
    for (const tool of mcpTools) {
      const schema =
        tool.inputSchema !== undefined && tool.inputSchema !== null
          ? tool.inputSchema
          : { type: 'object', properties: {} }; // PHP `new \stdClass()` -> {}
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description !== undefined && tool.description !== null ? String(tool.description) : '',
          parameters: schema,
        },
      });
    }
    return tools;
  }
}
