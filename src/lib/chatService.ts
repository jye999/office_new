// Port of the old app's App\Services\ChatService (OpenAI chat-completions loop
// with MCP tool calling).

import { McpClient } from './mcp.js';

const SYSTEM_PROMPT = `You are an Inventory Management AI Assistant connected to a live inventory system via MCP (Model Context Protocol).

Your capabilities:
- Query current inventory levels, products, and stock data
- Add, update, or remove inventory items

Guidelines:
- Always use the available tools to interact with the inventory system — never fabricate data.
- Confirm actions before making destructive changes (deletions, large quantity adjustments).
- Format responses clearly with bullet points or tables when showing inventory data.
- If a tool call fails, explain the error and suggest alternatives.
- Be concise but thorough in your responses.
- Do not ask followup questions, just respond to the user's question.

Voice transcription awareness:
- Users often speak their requests via voice-to-text, so SKUs, locations, and product names may be mis-transcribed.
- SKUs are typically short alphanumeric codes like "R020WY", "BL15A", "MR200". Voice transcription may produce wrong letters, extra spaces, spelled-out digits (e.g. "are zero two zero" instead of "R020"), phonetic errors (e.g. "W Y" → "why"), or wrong case.
- When a SKU or location is NOT FOUND, do NOT just say "not found". Instead:
  1. Look at the conversation history for any similar SKUs or locations the user asked about before.
  2. Think about common voice transcription mistakes (letters that sound alike: B/D, M/N, F/S, P/T; numbers that sound alike: 15/50, 19/90; homophones).
  3. Suggest 1-3 possible corrections and ask the user to confirm which one they meant before retrying.
  4. Example: "I couldn't find SKU 'R020WI'. Did you mean **R020WY** (which appeared earlier in our conversation)? Or perhaps **R020WH**?"`;

const MAX_TOOL_ROUNDS = 10;

type Message = Record<string, unknown>;

// Test seam: replaces the OpenAI chat/completions POST so unit tests never
// reach api.openai.com. Receives the (already JSON-encoded) payload.
type OpenAiPost = (jsonBody: string) => Promise<Record<string, unknown>>;

let openAiPostImpl: OpenAiPost;

async function openAiPostHttp(jsonBody: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000); // Guzzle timeout 60
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: jsonBody,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API request failed: ${body}`); // Guzzle RequestException path
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export function setOpenAiPostForTests(fn: OpenAiPost | null): void {
  openAiPostImpl = fn ?? openAiPostHttp;
}

export class ChatService {
  private readonly mcpClient: McpClient;
  private readonly model: string;
  private cachedTools: Record<string, unknown>[] | null = null;

  constructor(mcpClient: McpClient) {
    this.mcpClient = mcpClient;
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4o';
    void process.env.OPENAI_API_KEY; // read in openAiPostHttp (Laravel config())
  }

  // Fetch and cache MCP tools converted to OpenAI format.
  private async getTools(): Promise<Record<string, unknown>[]> {
    if (this.cachedTools !== null) return this.cachedTools;
    try {
      const mcpTools = await this.mcpClient.listTools();
      this.cachedTools = this.mcpClient.toOpenAiTools(mcpTools);
      console.log('MCP tools loaded', { count: this.cachedTools.length });
    } catch (e) {
      console.warn('Failed to load MCP tools, proceeding without tools', { error: (e as Error).message });
      this.cachedTools = [];
    }
    return this.cachedTools;
  }

  // Full tool-calling loop. Returns ['reply' => string, 'history' => array].
  async chat(userMessage: string, conversationHistory: Message[] = []): Promise<{ reply: string; history: Message[] }> {
    const tools = await this.getTools();

    const messages: Message[] = conversationHistory;

    if (messages.length === 0 || messages[0].role !== 'system') {
      messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }

    messages.push({ role: 'user', content: userMessage });

    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const response = await this.callOpenAi(messages, tools);

      const choice = (response.choices as { message: Message; finish_reason: string }[])[0];
      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      if (choice.finish_reason !== 'tool_calls' || !Array.isArray(assistantMessage.tool_calls) || assistantMessage.tool_calls.length === 0) {
        return {
          reply: typeof assistantMessage.content === 'string' ? assistantMessage.content : '',
          history: messages,
        };
      }

      for (const toolCall of assistantMessage.tool_calls as { id: string; function: { name: string; arguments: string } }[]) {
        const functionName = toolCall.function.name;
        let arguments_: Record<string, unknown> = {};
        try {
          const decoded = JSON.parse(toolCall.function.arguments);
          if (decoded !== null && typeof decoded === 'object') arguments_ = decoded as Record<string, unknown>;
        } catch {
          arguments_ = {}; // json_decode(...) ?: []
        }

        console.log('Calling MCP tool', { tool: functionName, args: arguments_ });

        let resultContent: string;
        try {
          const result = await this.mcpClient.callTool(functionName, arguments_);
          const encoded = JSON.stringify(result) ?? '(encode failed)';
          console.log('MCP tool result', { tool: functionName, result: encoded.slice(0, 2000) }); // mb_strimwidth(..., 2000)
          resultContent = this.formatToolResult(result);
        } catch (e) {
          console.error('MCP tool call failed', { tool: functionName, error: (e as Error).message });
          resultContent = JSON.stringify({ error: `Tool call failed: ${(e as Error).message}` });
        }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultContent });
      }
    }

    return {
      reply: 'I reached the maximum number of tool interactions. Please try simplifying your request.',
      history: messages,
    };
  }

  // Call the OpenAI Chat Completions API.
  private async callOpenAi(messages: Message[], tools: Record<string, unknown>[] = []): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    // PHP json_encode with JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
    // JSON.stringify never escapes non-ASCII and JS strings are always encodable.
    const jsonBody = JSON.stringify(payload);
    return openAiPostImpl(jsonBody);
  }

  private formatToolResult(result: unknown): string {
    if (result !== null && typeof result === 'object') {
      const r = result as { content?: unknown };
      if (Array.isArray(r.content)) {
        const parts: string[] = [];
        for (const block of r.content as Record<string, unknown>[]) {
          if (typeof block.text === 'string') parts.push(block.text);
          else if (block.type === 'text') parts.push(typeof block.text === 'string' ? block.text : '');
          else parts.push(JSON.stringify(block));
        }
        return parts.join('\n');
      }
    }
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  }
}
