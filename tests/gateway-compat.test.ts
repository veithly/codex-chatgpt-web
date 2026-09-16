import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import type { CodexProviderConfig, CodexParsedRequest } from "../src/types";
import {
  extractChatGptTurnUserRevision,
  extractCodexTurnIdentityFromBody,
} from "../src/adapters/chatgpt-web/environment";
import { defaultConfig, type AppConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { prepareResponsesTurn, startServer } from "../src/server";
import { chatCompletionsRequest, translateChatCompletions } from "../src/gateway/openai-compat";
import {
  anthropicCountTokensRequest,
  anthropicMessagesRequest,
  translateAnthropicMessages,
} from "../src/gateway/anthropic-compat";
import { resolveGatewayModelSlug } from "../src/gateway/model-mapping";
import { synthesizeGatewayTurnContext } from "../src/gateway/turn-context";
import { GatewayToolCallFilter } from "../src/gateway/tool-protocol";

type AdapterEvent = Parameters<Parameters<ProviderAdapter["runTurn"]>[2]>[0];
type AdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

function gatewayConfig(mode: "browser-only" | "full" = "browser-only"): AppConfig {
  const config = defaultConfig(mode);
  config.port = 0;
  return config;
}

function fakeAdapter(behavior: (parsed: CodexParsedRequest, emit: (event: AdapterEvent) => void) => Promise<void>): AdapterFactory {
  return (): ProviderAdapter => ({
    name: "gateway-test",
    async runTurn(parsed, _incoming, emit) {
      await behavior(parsed, emit);
    },
  });
}

function textAdapter(text: string): AdapterFactory {
  return fakeAdapter(async (_parsed, emit) => {
    emit({ type: "text_delta", text });
    emit({ type: "done", endTurn: true, usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } });
  });
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("gateway turn synthesis", () => {
  test("synthesizes turn identity and tags the current user message", () => {
    const body: Record<string, unknown> = {
      model: "chatgpt-web/high",
      input: [
        { type: "message", role: "user", content: "earlier" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] },
        { type: "message", role: "user", content: "hello gateway" },
      ],
    };
    const synthesis = synthesizeGatewayTurnContext(body);
    expect(synthesis).toBeDefined();
    const metadata = (body.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"] as string;
    expect(JSON.parse(metadata)).toMatchObject({ thread_id: expect.any(String), turn_id: expect.any(String), request_kind: "turn" });
    const input = body.input as Array<Record<string, unknown>>;
    const last = input[input.length - 1]!;
    expect((last.internal_chat_message_metadata_passthrough as Record<string, unknown>).turn_id).toBe(
      JSON.parse(metadata).turn_id,
    );
    // Earlier history stays untagged for fresh threads.
    expect(input[0]!.internal_chat_message_metadata_passthrough).toBeUndefined();
  });

  test("synthesized bodies satisfy the real adapter authority chain", () => {
    const body: Record<string, unknown> = {
      model: "chatgpt-web/high",
      instructions: "Answer concisely.",
      input: "Fix the failing test in src/app.ts",
    };
    expect(synthesizeGatewayTurnContext(body)).toBeDefined();
    const identity = extractCodexTurnIdentityFromBody(body);
    expect(identity.threadId).toBeTruthy();
    expect(identity.turnId).toBeTruthy();
    const parsed = parseRequest(body);
    // These are the exact validations that reject non-Codex clients today.
    expect(() => extractChatGptTurnUserRevision(parsed)).not.toThrow();
  });

  test("prompt_cache_key produces deterministic stable-thread turn ids", () => {
    const build = () => {
      const body: Record<string, unknown> = {
        model: "chatgpt-web/luna",
        prompt_cache_key: "harness-session-1",
        input: [
          { type: "message", role: "user", content: "first question" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] },
          { type: "message", role: "user", content: "second question" },
        ],
      };
      synthesizeGatewayTurnContext(body);
      return body;
    };
    const first = build();
    const second = build();
    const idOf = (body: Record<string, unknown>) => {
      const metadata = (body.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"] as string;
      return JSON.parse(metadata).thread_id as string;
    };
    expect(idOf(first)).toBe(idOf(second));
    const firstInput = first.input as Array<Record<string, unknown>>;
    const secondInput = second.input as Array<Record<string, unknown>>;
    expect((firstInput[0]!.internal_chat_message_metadata_passthrough as Record<string, unknown>).turn_id)
      .toBe((secondInput[0]!.internal_chat_message_metadata_passthrough as Record<string, unknown>).turn_id);
    // Assistant history is tagged with its producing turn so Luna's exact-parent checkpoint matches.
    expect((firstInput[1]!.internal_chat_message_metadata_passthrough as Record<string, unknown>).turn_id)
      .toBe((firstInput[0]!.internal_chat_message_metadata_passthrough as Record<string, unknown>).turn_id);
  });

  test("native Codex metadata is never touched", () => {
    const body: Record<string, unknown> = {
      model: "chatgpt-web/high",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_native", turn_id: "turn_native" }),
      },
      input: [{ type: "message", role: "user", content: "hi" }],
    };
    const snapshot = JSON.stringify(body);
    expect(synthesizeGatewayTurnContext(body)).toBeUndefined();
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  test("raw /v1/responses requests without Codex metadata now reach the adapter", async () => {
    let seenIdentity = false;
    const prepared = await prepareResponsesTurn(
      {
        model: "chatgpt-web/high",
        input: "hello from an OpenAI SDK client",
        stream: false,
      },
      gatewayConfig(),
      fakeAdapter(async (parsed, emit) => {
        seenIdentity = extractCodexTurnIdentityFromBody(parsed._rawBody).turnId !== undefined;
        emit({ type: "text_delta", text: "gateway ok" });
        emit({ type: "done", endTurn: true });
      }),
      { rememberState: false },
    );
    expect(prepared.error).toBeUndefined();
    expect(seenIdentity).toBeTrue();
    expect(prepared.turn!.parsed.stream).toBeFalse();
    await prepared.turn!.runPromise;
    const events = await prepared.turn!.queue.collect();
    expect(events.some(event => event.type === "text_delta")).toBeTrue();
  });
});

describe("gateway model mapping", () => {
  test("maps effort and family aliases onto available routes", () => {
    const config = gatewayConfig();
    expect(resolveGatewayModelSlug("chatgpt-web/pro", undefined, config)).toBe("chatgpt-web/pro");
    expect(resolveGatewayModelSlug("gpt-5.6", "low", config)).toBe("chatgpt-web/light");
    expect(resolveGatewayModelSlug("gpt-5.6", "high", config)).toBe("chatgpt-web/high");
    expect(resolveGatewayModelSlug("claude-sonnet-4-5", undefined, config)).toBe("chatgpt-web/high");
    expect(resolveGatewayModelSlug("claude-haiku-4", undefined, config)).toBe("chatgpt-web/light");
    expect(resolveGatewayModelSlug("whatever-model", undefined, config)).toBe("chatgpt-web/high");
  });

  test("luna-only accounts map onto luna routes", () => {
    const config = gatewayConfig();
    config.solAvailable = false;
    expect(resolveGatewayModelSlug("gpt-5.2", "low", config)).toBe("chatgpt-web/luna");
    expect(resolveGatewayModelSlug("gpt-5.2", "high", config)).toBe("chatgpt-web/think");
  });

  test("pro effort degrades to extra-high when pro is unavailable", () => {
    const config = gatewayConfig();
    config.proAvailable = false;
    expect(resolveGatewayModelSlug("claude-opus-4", undefined, config)).toBe("chatgpt-web/high");
  });
});

describe("chat completions gateway", () => {
  test("translates messages and returns a chat completion", async () => {
    const response = await chatCompletionsRequest(
      post("http://127.0.0.1/v1/chat/completions", {
        model: "gpt-5.6",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "hello" },
        ],
      }),
      gatewayConfig(),
      textAdapter("hi from chatgpt web"),
      { rememberState: false },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-5.6");
    expect(body.choices[0].message.content).toBe("hi from chatgpt web");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toMatchObject({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
  });

  test("streams chat completion chunks with usage and DONE", async () => {
    const response = await chatCompletionsRequest(
      post("http://127.0.0.1/v1/chat/completions", {
        model: "chatgpt-web/high",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      gatewayConfig(),
      textAdapter("streamed answer"),
      { rememberState: false },
    );
    const text = await response.text();
    const frames = text.split("\n\n").filter(Boolean);
    expect(frames[0]).toContain('"role":"assistant"');
    expect(text).toContain("streamed answer");
    expect(text).toContain("[DONE]");
    const usageFrame = frames.find(frame => frame.includes('"prompt_tokens":120'));
    expect(usageFrame).toBeDefined();
  });

  test("relays the prompt-level tool protocol as tool_calls", async () => {
    let sawContract = false;
    const sentinelText = 'Let me check the weather. <<<GW_TOOLS>>>[{"name":"get_weather","arguments":{"city":"Paris"}}]<<<END_GW_TOOLS>>>';
    const response = await chatCompletionsRequest(
      post("http://127.0.0.1/v1/chat/completions", {
        model: "chatgpt-web/high",
        messages: [{ role: "user", content: "What is the weather in Paris?" }],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather lookup",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        }],
      }),
      gatewayConfig(),
      fakeAdapter(async (parsed, emit) => {
        sawContract = (parsed.context.systemPrompt ?? []).some(text => text.includes("gateway_tool_protocol"));
        expect(parsed.context.tools).toContainEqual(expect.objectContaining({ name: "get_weather" }));
        emit({ type: "text_delta", text: sentinelText.slice(0, 40) });
        emit({ type: "text_delta", text: sentinelText.slice(40) });
        emit({ type: "done", endTurn: true });
      }),
      { rememberState: false },
    );
    expect(sawContract).toBeTrue();
    const body = await response.json() as any;
    const message = body.choices[0].message;
    expect(message.content).toBe("Let me check the weather. ");
    expect(message.content).not.toContain("GW_TOOLS");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(message.tool_calls).toEqual([{
      id: expect.any(String),
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Paris"}' },
    }]);
  });

  test("tool results round-trip into the compiled context", async () => {
    const { raw } = translateChatCompletions({
      model: "chatgpt-web/high",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "22C sunny" },
      ],
    }, gatewayConfig());
    const parsed = parseRequest(raw);
    expect(parsed.context.messages).toContainEqual(expect.objectContaining({
      role: "toolResult",
      toolCallId: "call_1",
    }));
    const assistant = parsed.context.messages.find(message => message.role === "assistant");
    expect(assistant && "content" in assistant && Array.isArray(assistant.content)
      ? assistant.content[0]
      : undefined).toMatchObject({ type: "toolCall", name: "get_weather" });
  });
});

describe("anthropic gateway", () => {
  test("translates system, tools, and tool_result blocks", async () => {
    const { raw } = translateAnthropicMessages({
      model: "claude-sonnet-4-5",
      system: "You are Claude Code running on ChatGPT Web.",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "src tests" }],
          }],
        },
        { role: "user", content: "now summarize" },
      ],
      tools: [{ name: "Bash", description: "Run commands", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    }, gatewayConfig());
    expect(raw.instructions).toBe("You are Claude Code running on ChatGPT Web.");
    expect(raw.model).toBe("chatgpt-web/high");
    const parsed = parseRequest(raw);
    const toolResult = parsed.context.messages.find(message => message.role === "toolResult");
    expect(toolResult).toMatchObject({ role: "toolResult", toolCallId: "toolu_1" });
    const lastUser = [...parsed.context.messages].reverse().find(message => message.role === "user");
    expect(lastUser).toMatchObject({ role: "user", content: "now summarize" });
  });

  test("returns an anthropic message with tool_use blocks", async () => {
    const sentinel = 'Checking files. <<<GW_TOOLS>>>[{"name":"Bash","arguments":{"command":"ls"}}]<<<END_GW_TOOLS>>>';
    const response = await anthropicMessagesRequest(
      post("http://127.0.0.1/v1/messages", {
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        stream: false,
        messages: [{ role: "user", content: "list files" }],
        tools: [{ name: "Bash", description: "Run commands", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
      }),
      gatewayConfig(),
      fakeAdapter(async (_parsed, emit) => {
        emit({ type: "text_delta", text: sentinel });
        emit({ type: "done", endTurn: true });
      }),
      { rememberState: false },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.type).toBe("message");
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([expect.objectContaining({
      type: "text",
      text: "Checking files. ",
    }), {
      type: "tool_use",
      id: expect.any(String),
      name: "Bash",
      input: { command: "ls" },
    }]);
  });

  test("streams anthropic SSE blocks in protocol order", async () => {
    const response = await anthropicMessagesRequest(
      post("http://127.0.0.1/v1/messages", {
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        stream: true,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "hello" }],
      }),
      gatewayConfig(),
      fakeAdapter(async (_parsed, emit) => {
        emit({ type: "thinking_delta", thinking: "pondering" });
        emit({ type: "text_delta", text: "answer part" });
        emit({ type: "done", endTurn: true, usage: { inputTokens: 10, outputTokens: 5 } });
      }),
      { rememberState: false },
    );
    const text = await response.text();
    const types = [...text.matchAll(/event: ([a-z_]+)/g)].map(match => match[1]);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(text).toContain('"type":"thinking_delta"');
    expect(text).toContain("answer part");
    expect(types[types.length - 1]).toBe("message_stop");
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  test("thinking blocks are only emitted when the client enables them", async () => {
    const adapter = fakeAdapter(async (_parsed, emit) => {
      emit({ type: "thinking_delta", thinking: "secret thoughts" });
      emit({ type: "text_delta", text: "visible" });
      emit({ type: "done", endTurn: true });
    });
    const withThinking = await anthropicMessagesRequest(
      post("http://127.0.0.1/v1/messages", {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "hi" }],
      }),
      gatewayConfig(),
      adapter,
      { rememberState: false },
    );
    const withThinkingBody = await withThinking.json() as any;
    expect(withThinkingBody.content).toEqual([expect.objectContaining({ type: "thinking", thinking: "secret thoughts" }), expect.objectContaining({ type: "text" })]);

    const withoutThinking = await anthropicMessagesRequest(
      post("http://127.0.0.1/v1/messages", {
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
      gatewayConfig(),
      adapter,
      { rememberState: false },
    );
    const withoutThinkingBody = await withoutThinking.json() as any;
    expect(withoutThinkingBody.content).toEqual([expect.objectContaining({ type: "text", text: "visible" })]);
  });

  test("count tokens estimates from messages and tools", async () => {
    const response = await anthropicCountTokensRequest(
      post("http://127.0.0.1/v1/messages/count_tokens", {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "How many tokens is this sentence roughly?" }],
        tools: [{ name: "Bash", description: "Run commands", input_schema: { type: "object" } }],
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(10);
  });
});

describe("tool call filter", () => {
  test("suppresses sentinel blocks split across deltas and recovers prose", () => {
    const filter = new GatewayToolCallFilter();
    const events = [
      ...filter.push("I will run the command now."),
      ...filter.push(" <<<GW_TO"),
      ...filter.push("OLS>>>[{\"name\":\"sh\""),
      ...filter.push(",\"arguments\":{\"cmd\":\"ls\"}}]<<<END_GW_TOOLS>>>"),
      ...filter.flush(),
    ];
    const text = events.filter(event => event.type === "text_delta").map(event => (event as any).text).join("");
    expect(text).toBe("I will run the command now. ");
    const starts = events.filter(event => event.type === "tool_call_start");
    expect(starts).toEqual([{ type: "tool_call_start", id: expect.any(String), name: "sh" }]);
    const args = events.filter(event => event.type === "tool_call_delta").map(event => (event as any).arguments).join("");
    expect(JSON.parse(args)).toEqual({ cmd: "ls" });
  });

  test("an unterminated block degrades to visible prose", () => {
    const filter = new GatewayToolCallFilter();
    const events = [
      ...filter.push("working <<<GW_TOOLS>>>[{\"name\":\"x\"}"),
      ...filter.flush(),
    ];
    const text = events.filter(event => event.type === "text_delta").map(event => (event as any).text).join("");
    expect(text).toContain("working");
    expect(text).toContain('{"name":"x"}');
    expect(filter.toolCalls).toHaveLength(0);
  });
});

describe("gateway server surface", () => {
  test("unauthenticated /v1/models serves the gateway catalog", async () => {
    const server = startServer(gatewayConfig(), { adapterFactory: textAdapter("unused") });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.object).toBe("list");
      const ids = body.data.map((model: { id: string }) => model.id);
      expect(ids).toContain("chatgpt-web/high");
      expect(ids).toContain("gpt-5.6");
    } finally {
      await server.stop(true);
    }
  });

  test("POST /v1/chat/completions works end-to-end through the HTTP server", async () => {
    const server = startServer(gatewayConfig(), { adapterFactory: textAdapter("server roundtrip") });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer dummy-key" },
        body: JSON.stringify({ model: "gpt-5.6", messages: [{ role: "user", content: "ping" }] }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.choices[0].message.content).toBe("server roundtrip");
    } finally {
      await server.stop(true);
    }
  });

  test("POST /v1/messages works end-to-end through the HTTP server", async () => {
    const server = startServer(gatewayConfig(), { adapterFactory: textAdapter("claude ready") });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "dummy" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 128,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.type).toBe("message");
      expect(body.content[0]).toMatchObject({ type: "text", text: "claude ready" });
    } finally {
      await server.stop(true);
    }
  });
});
