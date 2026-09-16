import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { VERSION } from "../version";

/**
 * Harness-facing MCP server (`codex-chatgpt-web harness serve`).
 *
 * A stdio MCP server that any MCP-capable harness — Pi, Oh My Pi, Claude Code, ZCode, Codex
 * Desktop, Claude Desktop — can register. It exposes the signed-in ChatGPT Web session as ordinary
 * chat tools by speaking to the local daemon's OpenAI-compatible gateway on loopback. Conversation
 * state is kept per session id, and every request carries a deterministic prompt_cache_key derived
 * from that id, so sequential calls continue the SAME browser chat (retained conversation) instead
 * of opening a fresh Temporary Chat per message.
 */

interface SessionState {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  updatedAt: number;
}

const MAX_SESSION_MESSAGES = 200;
const MAX_SESSIONS = 128;

function daemonBaseUrl(): string {
  try {
    const configPath = join(getConfigDir(), "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { port?: number };
      if (Number.isInteger(config.port) && config.port! > 0) return `http://127.0.0.1:${config.port}`;
    }
  } catch {
    // Fall through to the documented default port.
  }
  return "http://127.0.0.1:17841";
}

function sessionCachePath(): string {
  return join(getConfigDir(), "runtime", "harness-mcp-sessions.json");
}

export class HarnessMcpSessions {
  private readonly sessions = new Map<string, SessionState>();
  private loaded = false;

  constructor(
    private readonly path = sessionCachePath(),
    private readonly persist: (path: string, data: string) => void = defaultPersist,
  ) {}

  get(sessionId: string): SessionState | undefined {
    this.load();
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, state: SessionState): void {
    this.load();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, state);
    this.prune();
    this.flush();
  }

  delete(sessionId: string): boolean {
    this.load();
    const removed = this.sessions.delete(sessionId);
    if (removed) this.flush();
    return removed;
  }

  private flush(): void {
    try {
      this.persist(this.path, JSON.stringify(Object.fromEntries(this.sessions)));
    } catch {
      // Session persistence is best-effort; in-memory state keeps the conversation usable.
    }
  }

  private prune(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      for (const [id, value] of Object.entries(raw)) {
        const state = value as SessionState;
        if (!state || !Array.isArray(state.messages)) continue;
        this.sessions.set(id, { messages: state.messages, updatedAt: Number(state.updatedAt) || 0 });
      }
    } catch {
      // Corrupt snapshot: start empty.
    }
  }
}

function defaultPersist(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, `${data}\n`, { protectDirectory: false });
}

export async function runHarnessMcpServer(options: { baseUrl?: string } = {}): Promise<void> {
  const baseUrl = options.baseUrl ?? daemonBaseUrl();
  const sessions = new HarnessMcpSessions();
  const server = new McpServer(
    { name: "chatgpt-web", version: VERSION },
    {
      instructions: [
        "Chat with the signed-in ChatGPT Web account through the local Codex Web GPT bridge.",
        "Use chatgpt_web_chat for every model request; pass a stable session_id per conversation",
        "so follow-up messages continue the same ChatGPT chat. Use chatgpt_web_models to list models.",
      ].join(" "),
    },
  );

  const chatCompletion = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer harness-mcp" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `The chatgpt-web daemon is not reachable at ${baseUrl}. Start the Codex Web GPT launcher first`
          + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = await response.json() as Record<string, unknown>;
    } catch {
      throw new Error(`chatgpt-web gateway returned a non-JSON response (HTTP ${response.status}). Update the launcher to the gateway build.`);
    }
    if (!response.ok) {
      const error = payload.error as { message?: string } | undefined;
      throw new Error(error?.message ?? `chatgpt-web gateway returned HTTP ${response.status}`);
    }
    return payload;
  };

  server.registerTool(
    "chatgpt_web_models",
    {
      title: "List ChatGPT Web models",
      description: "List the ChatGPT Web models exposed by the local bridge for the signed-in account.",
      inputSchema: {},
      outputSchema: {
        models: z.array(z.object({ id: z.string() })),
      },
    },
    async () => {
      const response = await fetch(`${baseUrl}/v1/models`);
      if (!response.ok) {
        throw new Error(`The chatgpt-web daemon is not reachable at ${baseUrl} (HTTP ${response.status}). Start the Codex Web GPT launcher first.`);
      }
      const catalog = await response.json() as { data?: Array<{ id?: string }> };
      const models = (catalog.data ?? [])
        .map(model => ({ id: typeof model.id === "string" ? model.id : "" }))
        .filter(model => model.id && !model.id.endsWith("-auto"));
      return {
        content: [{ type: "text" as const, text: models.map(model => model.id).join("\n") }],
        structuredContent: { models },
      };
    },
  );

  server.registerTool(
    "chatgpt_web_chat",
    {
      title: "Chat with ChatGPT Web",
      description: [
        "Send a prompt to the signed-in ChatGPT Web account (the bridge's browser chat).",
        "Pass the same session_id for every message of one conversation so follow-ups continue the",
        "same chat; omit session_id to use the shared default conversation. A turn can take minutes",
        "while ChatGPT thinks — keep the client timeout generous.",
      ].join(" "),
      inputSchema: {
        prompt: z.string().min(1).describe("The user message to send."),
        session_id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional()
          .describe("Stable conversation id (default: \"default\"). Reuse one id per conversation."),
        model: z.string().optional()
          .describe("Model hint (e.g. \"chatgpt-web/high\", \"gpt-5.6\", \"claude-sonnet\"). Defaults to the best available route."),
        reset: z.boolean().optional()
          .describe("Forget this session's history before sending (starts a fresh conversation)."),
      },
      outputSchema: {
        response: z.string(),
        session_id: z.string(),
      },
    },
    async ({ prompt, session_id, model, reset }) => {
      const sessionId = session_id ?? "default";
      if (reset === true) sessions.delete(sessionId);
      const previous = sessions.get(sessionId)?.messages ?? [];
      const messages = [...previous, { role: "user" as const, content: prompt }];
      // The stable cache key is what keeps the SAME browser chat across calls.
      const payload = await chatCompletion({
        model: model ?? "chatgpt-web",
        messages,
        prompt_cache_key: `harness-${sessionId}`,
      });
      const choice = (payload.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0];
      const content = choice?.message?.content;
      const text = typeof content === "string" ? content : "";
      if (!text) throw new Error("ChatGPT Web returned an empty response.");
      sessions.set(sessionId, {
        messages: [...messages, { role: "assistant" as const, content: text }].slice(-MAX_SESSION_MESSAGES),
        updatedAt: Date.now(),
      });
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { response: text, session_id: sessionId },
      };
    },
  );

  server.registerTool(
    "chatgpt_web_reset",
    {
      title: "Reset a ChatGPT Web session",
      description: "Forget a session's conversation history. The next chatgpt_web_chat starts a fresh chat.",
      inputSchema: {
        session_id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional().describe("Session id to reset (default: \"default\")."),
      },
      outputSchema: { reset: z.literal(true) },
    },
    async ({ session_id }) => {
      sessions.delete(session_id ?? "default");
      return {
        content: [{ type: "text" as const, text: "Session history cleared." }],
        structuredContent: { reset: true as const },
      };
    },
  );

  await server.connect(new StdioServerTransport());
}
