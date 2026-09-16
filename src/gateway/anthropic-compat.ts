import type { AdapterEvent, CodexParsedRequest, CodexUsage } from "../types";
import { readJsonRequestBody } from "../http-body";
import { formatErrorResponse } from "../bridge";
import { adapterFailureFromMessage } from "../lib/errors";
import { estimateTokens } from "../lib/token-estimate";
import type { AppConfig } from "../config";
import {
  prepareResponsesTurn,
  type ChatGptWebAdapterFactory,
  type PreparedResponsesTurn,
  type ResponseRequestOptions,
} from "../server";
import { GatewayToolCallFilter, gatewayToolContract } from "./tool-protocol";
import { resolveGatewayModelSlug, GatewayModelError } from "./model-mapping";

/**
 * Anthropic Messages compatibility surface (`POST /v1/messages`).
 *
 * This is the endpoint Claude Code and other Anthropic-native harnesses speak: point
 * ANTHROPIC_BASE_URL at this daemon (any ANTHROPIC_AUTH_TOKEN value works, requests stay on
 * loopback) and the whole harness — Bash, Edit, subagents, images — runs on the signed-in ChatGPT
 * Web session. Translation mirrors the OpenAI-compat gateway: system prompts, tool
 * definitions/results, and images map onto the Responses wire; the model's tool invocations come
 * back through the prompt-level tool protocol as standard tool_use blocks.
 */

export interface TranslatedAnthropicRequest {
  raw: Record<string, unknown>;
  requestedModel: string;
  thinkingEnabled: boolean;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map(part => {
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(text => text.trim().length > 0)
    .join("\n\n");
}

function imagePartOf(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = record.source;
  if (typeof source !== "object" || source === null) return undefined;
  const src = source as Record<string, unknown>;
  if (src.type === "base64" && typeof src.media_type === "string" && typeof src.data === "string") {
    return { type: "input_image", image_url: `data:${src.media_type};base64,${src.data}` };
  }
  if (src.type === "url" && typeof src.url === "string") {
    return { type: "input_image", image_url: src.url };
  }
  return undefined;
}

function toolResultOutput(content: unknown): string | unknown[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: unknown[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({ type: "output_text", text: record.text });
    } else if (record.type === "image") {
      const image = imagePartOf(record);
      if (image) parts.push(image);
    }
  }
  if (parts.every(part => (part as { type?: string }).type === "output_text")) {
    return parts.map(part => (part as { text: string }).text).join("");
  }
  return parts;
}

export function translateAnthropicMessages(
  body: Record<string, unknown>,
  config: AppConfig,
): TranslatedAnthropicRequest {
  const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "chatgpt-web";
  const model = resolveGatewayModelSlug(requestedModel, undefined, config);
  const thinking = body.thinking;
  const thinkingEnabled = typeof thinking === "object" && thinking !== null
    && (thinking as Record<string, unknown>).type === "enabled";

  const instructions = systemText(body.system);
  const input: unknown[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];

  for (const value of messages) {
    if (typeof value !== "object" || value === null) continue;
    const message = value as Record<string, unknown>;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;

    if (typeof content === "string") {
      if (content) {
        input.push({
          type: "message",
          role,
          content: [{ type: role === "user" ? "input_text" : "output_text", text: content }],
        });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      const textChunks: string[] = [];
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue;
        const record = part as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string" && record.text) {
          textChunks.push(record.text);
        } else if (record.type === "tool_use" && typeof record.name === "string") {
          if (textChunks.length > 0) {
            input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: textChunks.join("") }],
            });
            textChunks.length = 0;
          }
          input.push({
            type: "function_call",
            call_id: typeof record.id === "string" && record.id ? record.id : `call_${input.length}_${record.name}`,
            name: record.name,
            arguments: JSON.stringify(record.input ?? {}),
          });
        }
        // thinking blocks in replayed assistant history are dropped: gateway turns never require
        // them, and the browser contract treats assistant history as prose.
      }
      if (textChunks.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: textChunks.join("") }],
        });
      }
      continue;
    }

    // user message: text/image blocks and tool_result blocks interleaved.
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        if (record.text) {
          input.push({ type: "message", role: "user", content: [{ type: "input_text", text: record.text }] });
        }
      } else if (record.type === "image") {
        const image = imagePartOf(record);
        if (image) input.push({ type: "message", role: "user", content: [image] });
      } else if (record.type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: typeof record.tool_use_id === "string" && record.tool_use_id ? record.tool_use_id : "",
          output: toolResultOutput(record.content),
        });
      }
    }
  }

  const raw: Record<string, unknown> = {
    model,
    input,
    store: false,
    reasoning: { summary: "auto" },
  };
  if (instructions.trim()) raw.instructions = instructions;

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const functionTools: unknown[] = [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const record = tool as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) continue;
    functionTools.push({
      type: "function",
      name: record.name,
      description: typeof record.description === "string" ? record.description : "",
      parameters: (record.input_schema && typeof record.input_schema === "object"
        ? record.input_schema
        : { type: "object", properties: {} }) as Record<string, unknown>,
    });
  }
  if (functionTools.length > 0) raw.tools = functionTools;

  const toolChoice = body.tool_choice;
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const choice = toolChoice as Record<string, unknown>;
    if (choice.type === "auto") raw.tool_choice = "auto";
    else if (choice.type === "any") raw.tool_choice = "required";
    else if (choice.type === "none") raw.tool_choice = "none";
    else if (choice.type === "tool" && typeof choice.name === "string") {
      raw.tool_choice = { type: "function", name: choice.name };
    }
  }
  if (typeof body.max_tokens === "number") raw.max_output_tokens = body.max_tokens;
  if (typeof body.temperature === "number") raw.temperature = body.temperature;
  if (typeof body.top_p === "number") raw.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) raw.stop = body.stop_sequences;
  return { raw, requestedModel, thinkingEnabled };
}

type AnthropicBlockType = "text" | "thinking" | "tool_use";

interface AnthropicBlock {
  type: AnthropicBlockType;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  bufferedArguments?: string;
}

interface AbsorbedDelta {
  block?: AnthropicBlock;
  created: boolean;
  text?: string;
  json?: string;
}

const NO_DELTA: AbsorbedDelta = { created: false };

/** Ordered content-block assembly shared by the streaming and buffered encoders. */
class AnthropicOutput {
  blocks: AnthropicBlock[] = [];
  usage?: CodexUsage;
  incomplete = false;
  error?: { message: string; status?: number; errorType?: string; code?: string };

  absorb(event: AdapterEvent, thinkingEnabled: boolean): AbsorbedDelta {
    switch (event.type) {
      case "text_delta": {
        const block = this.ensureBlock("text");
        block.text = (block.text ?? "") + event.text;
        return { block, created: false, text: event.text };
      }
      case "thinking_delta":
      case "reasoning_raw_delta": {
        if (!thinkingEnabled) return NO_DELTA;
        const delta = event.type === "thinking_delta" ? event.thinking : event.text;
        const block = this.ensureBlock("thinking");
        block.thinking = (block.thinking ?? "") + delta;
        return { block, created: false, text: delta };
      }
      case "tool_call_start": {
        const block: AnthropicBlock = { type: "tool_use", id: event.id, name: event.name, bufferedArguments: "" };
        this.blocks.push(block);
        return { block, created: true };
      }
      case "tool_call_delta": {
        const last = this.blocks[this.blocks.length - 1];
        if (last?.type !== "tool_use") return NO_DELTA;
        last.bufferedArguments = (last.bufferedArguments ?? "") + event.arguments;
        return { block: last, created: false, json: event.arguments };
      }
      case "done":
        this.usage = event.usage;
        return NO_DELTA;
      case "incomplete":
        this.usage = event.usage;
        this.incomplete = true;
        return NO_DELTA;
      case "error":
        this.error = {
          message: event.message,
          status: event.status,
          errorType: event.errorType,
          code: event.code,
        };
        return NO_DELTA;
      default:
        return NO_DELTA;
    }
  }

  private ensureBlock(type: AnthropicBlockType): AnthropicBlock {
    const last = this.blocks[this.blocks.length - 1];
    if (last?.type === type) return last;
    const block: AnthropicBlock = type === "tool_use"
      ? { type, bufferedArguments: "" }
      : { type, ...(type === "text" ? { text: "" } : { thinking: "" }) };
    this.blocks.push(block);
    return block;
  }

  get stopReason(): "end_turn" | "tool_use" | "max_tokens" {
    if (this.blocks.some(block => block.type === "tool_use")) return "tool_use";
    return this.incomplete ? "max_tokens" : "end_turn";
  }

  /** Public content blocks: parsed tool arguments, no internal buffering keys. */
  contentBlocks(): Array<Record<string, unknown>> {
    return this.blocks.map(block => {
      if (block.type === "tool_use") {
        const argsText = block.bufferedArguments ?? "";
        let input: unknown = {};
        if (argsText.trim()) {
          try {
            input = JSON.parse(argsText);
            if (typeof input !== "object" || input === null || Array.isArray(input)) input = { value: input };
          } catch {
            input = { raw: argsText };
          }
        }
        return { type: "tool_use", id: block.id, name: block.name, input };
      }
      if (block.type === "thinking") {
        return { type: "thinking", thinking: block.thinking ?? "", signature: "" };
      }
      return { type: "text", text: block.text ?? "" };
    });
  }
}

function absorbThroughFilter(event: AdapterEvent, filter: GatewayToolCallFilter | undefined): AdapterEvent[] {
  if (!filter) return [event];
  if (event.type === "text_delta") return [...filter.push(event.text)];
  return [event];
}

function gatewayAdapterFactory(adapterFactory: ChatGptWebAdapterFactory): ChatGptWebAdapterFactory {
  return provider => {
    const adapter = adapterFactory(provider);
    return {
      name: adapter.name,
      async runTurn(parsed, incoming, emit) {
        const tools = parsed.context.tools;
        if (tools && tools.length > 0 && !parsed._compactionRequest && parsed.options.toolChoice !== "none") {
          parsed.context.systemPrompt = [
            ...(parsed.context.systemPrompt ?? []),
            gatewayToolContract(tools),
          ];
        }
        await adapter.runTurn!(parsed, incoming, emit);
      },
    };
  };
}

/** Best-effort prompt-size estimate for message_start usage before the turn completes. */
export function estimateGatewayInputTokens(parsed: CodexParsedRequest): number {
  try {
    const parts: string[] = [...(parsed.context.systemPrompt ?? [])];
    for (const message of parsed.context.messages) {
      parts.push(blockText(message.content));
    }
    if (parsed.context.tools) parts.push(JSON.stringify(parsed.context.tools));
    return estimateTokens(parts.join("\n"));
  } catch {
    return 0;
  }
}

export async function anthropicCountTokensRequest(
  req: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : "Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return formatErrorResponse(400, "invalid_request_error", "Count tokens request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  let total = systemText(record.system) ? estimateTokens(systemText(record.system)) : 0;
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      if (typeof message !== "object" || message === null) continue;
      total += estimateTokens(blockText((message as Record<string, unknown>).content));
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part !== "object" || part === null) continue;
          const blockRecord = part as Record<string, unknown>;
          if (blockRecord.type === "image") total += 1_600;
          else if (blockRecord.type === "tool_use") total += estimateTokens(JSON.stringify(blockRecord.input ?? {}));
          else if (blockRecord.type === "tool_result") total += estimateTokens(blockText(blockRecord.content));
        }
      }
    }
  }
  if (Array.isArray(record.tools)) total += estimateTokens(JSON.stringify(record.tools));
  return Response.json({ input_tokens: total });
}

export async function anthropicMessagesRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory,
  options: ResponseRequestOptions = {},
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : "Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return formatErrorResponse(400, "invalid_request_error", "Messages request body must be a JSON object");
  }
  let requestedModel = "chatgpt-web";
  let thinkingEnabled = false;
  let raw: Record<string, unknown>;
  try {
    const translated = translateAnthropicMessages(body as Record<string, unknown>, config);
    requestedModel = translated.requestedModel;
    thinkingEnabled = translated.thinkingEnabled;
    raw = translated.raw;
  } catch (error) {
    if (error instanceof GatewayModelError) return formatErrorResponse(error.status, "invalid_request_error", error.message);
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const wantsStream = (body as Record<string, unknown>).stream === true;
  raw.stream = false;

  const prepared = await prepareResponsesTurn(raw, config, gatewayAdapterFactory(adapterFactory), {
    ...options,
    signal: req.signal,
    headers: req.headers,
  });
  if (prepared.error) return prepared.error;
  const turn: PreparedResponsesTurn = prepared.turn;

  const tools = turn.parsed.context.tools;
  const filter = tools && tools.length > 0 && turn.parsed.options.toolChoice !== "none"
    ? new GatewayToolCallFilter()
    : undefined;
  const messageId = `msg_gw${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const output = new AnthropicOutput();
  const inputTokensEstimate = estimateGatewayInputTokens(turn.parsed);

  const errorMessage = (message: string, errorType?: string): string => JSON.stringify({
    type: "error",
    error: { type: errorType && errorType.endsWith("_error") ? errorType : "api_error", message },
  });

  if (wantsStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (frame: string) => controller.enqueue(encoder.encode(frame));
        const sse = (payload: Record<string, unknown>) => send(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
        sse({
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokensEstimate, output_tokens: 0 },
          },
        });
        let nextIndex = 0;
        const startBlocks = new Map<AnthropicBlock, number>();
        const handleDelta = (delta: AbsorbedDelta): void => {
          const block = delta.block;
          if (!block) return;
          let index = startBlocks.get(block);
          if (index === undefined) {
            index = nextIndex++;
            startBlocks.set(block, index);
            if (block.type === "text") {
              sse({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
            } else if (block.type === "thinking") {
              sse({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
            } else {
              sse({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
            }
          }
          if (delta.text !== undefined) {
            sse({
              type: "content_block_delta",
              index,
              delta: block.type === "thinking"
                ? { type: "thinking_delta", thinking: delta.text }
                : { type: "text_delta", text: delta.text },
            });
          } else if (delta.json !== undefined) {
            sse({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: delta.json } });
          }
        };
        try {
          for await (const event of turn.queue) {
            for (const concrete of absorbThroughFilter(event, filter)) {
              handleDelta(output.absorb(concrete, thinkingEnabled));
            }
          }
          await turn.runPromise;
          for (const concrete of filter ? [...filter.flush()] : []) {
            handleDelta(output.absorb(concrete, thinkingEnabled));
          }
        } catch (error) {
          send(errorMessage(error instanceof Error ? error.message : String(error)));
          controller.close();
          return;
        }
        for (const index of startBlocks.values()) {
          sse({ type: "content_block_stop", index });
        }
        if (output.error) {
          send(errorMessage(output.error.message, output.error.errorType));
          controller.close();
          return;
        }
        sse({
          type: "message_delta",
          delta: { stop_reason: output.stopReason, stop_sequence: null },
          usage: {
            input_tokens: output.usage?.inputTokens ?? inputTokensEstimate,
            output_tokens: output.usage?.outputTokens ?? 0,
          },
        });
        sse({ type: "message_stop" });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await turn.runPromise;
  for await (const event of turn.queue) {
    for (const concrete of absorbThroughFilter(event, filter)) output.absorb(concrete, thinkingEnabled);
  }
  for (const concrete of filter ? [...filter.flush()] : []) output.absorb(concrete, thinkingEnabled);
  if (output.error) {
    const status = output.error.status ?? adapterFailureFromMessage(output.error.message).httpStatus;
    return Response.json(
      { type: "error", error: { type: output.error.errorType ?? "api_error", message: output.error.message } },
      { status },
    );
  }
  return Response.json({
    id: messageId,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: output.contentBlocks(),
    stop_reason: output.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: output.usage?.inputTokens ?? inputTokensEstimate,
      output_tokens: output.usage?.outputTokens ?? 0,
    },
  });
}
