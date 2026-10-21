// Minimal ollama chat client for the comprehension LLM-bot. One request per
// turn: feed the directive + view, get back one move as JSON. No streaming.

export interface OllamaConfig {
  baseUrl: string; // e.g. http://192.168.68.100:11434
  model: string; // e.g. qwen3.6:35b
  temperature?: number; // default 0 — we want the model's best single answer
  think?: boolean; // qwen3.6 is a thinking model; default false for speed
  timeoutMs?: number; // per-request timeout, default 120s
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string; // the answer (thinking stripped)
  thinking?: string; // reasoning, if the model returned it separately
  raw: string; // the unmodified message content for the transcript
}

// ---- tool-calling (for the agentic assistant harness) -----------------------

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// One assistant turn in a tool-calling loop: either it asks to call tools, or it
// produces final spoken content (no tool calls), or both.
export interface ToolChatResult {
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  raw: unknown; // the raw message object for the transcript
}

export class OllamaClient {
  constructor(private readonly cfg: OllamaConfig) {}

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 120_000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          stream: false,
          think: this.cfg.think ?? false,
          options: { temperature: this.cfg.temperature ?? 0 },
        }),
      });
      if (!res.ok) {
        throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { message?: { content?: string; thinking?: string } };
      const raw = body.message?.content ?? '';
      const thinking = body.message?.thinking;
      // Strip any inline <think>...</think> the model embedded in content.
      const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      return { content, thinking, raw };
    } finally {
      clearTimeout(timeout);
    }
  }

  // One round of a tool-calling conversation. `messages` is the running history
  // (including prior tool results as {role:'tool'} entries). Returns the model's
  // tool-call requests and/or final content. Thinking is enabled by default here
  // — an agent benefits from reasoning about which tool to call.
  async chatTools(messages: unknown[], tools: ToolDef[]): Promise<ToolChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 180_000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          tools,
          stream: false,
          think: this.cfg.think ?? true,
          options: { temperature: this.cfg.temperature ?? 0 },
        }),
      });
      if (!res.ok) {
        throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
        };
      };
      const msg = body.message ?? {};
      const content = (msg.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
        .map((tc) => {
          const name = tc.function?.name;
          if (!name) return null;
          let args = tc.function?.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          return { name, arguments: (args ?? {}) as Record<string, unknown> };
        })
        .filter((c): c is ToolCall => c != null);
      return { content, thinking: msg.thinking, toolCalls, raw: msg };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Extract a single JSON object (a move) from a model's free-form reply. Tries a
// ```json fenced block first, then the first balanced {...} span. Returns null if
// nothing parses — that itself is a (format) comprehension failure we record.
export function extractMoveJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const span = firstBalancedObject(text);
  if (span) candidates.push(span);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
