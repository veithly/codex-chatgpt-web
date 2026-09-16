import type { AdapterEvent, CodexUsage } from "../types";
import { readJsonRequestBody } from "../http-body";
import { formatErrorResponse } from "../bridge";
import { adapterFailureFromMessage } from "../lib/errors";
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
 * OpenAI Chat Completions compatibility surface (`POST /v1/chat/completions`).
 *
 * Any harness that speaks the de-facto chat-completions protocol — aider, Open WebUI, LobeChat,
 * OpenAI SDKs, cursor-style tools — can point its base URL at this daemon with any API key value
 * and run its tasks through the signed-in ChatGPT Web session. Tool calls ride the gateway's
 * prompt-level tool protocol; reasoning summaries surface as `delta.reasoning_content`.
 */

export interface TranslatedRequest {
  raw: Record<string, unknown>;
  requestedModel: string;
}

function textParts(content: unknown): string {
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

function imageUrlOf(part: Record<string, unknown>): string | undefined {
  const url = part.image_url;
  if (typeof url === "string") return url;
  if (typeof url === "object" && url !== null && typeof (url as Record<string, unknown>).url === "string") {
    return (url as { url: string }).url;
  }
  return undefined;
}

/**
 * Translate chat-completions messages into Responses wire items. System/developer text becomes
 * `instructions` until the first non-system message; later system inserts become developer items so
 * instruction priority stays faithful to the conversation order.
 */
export function translateChatCompletions(body: Record<string, unknown>, config: AppConfig): TranslatedRequest {
  const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "chatgpt-web";
  const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
  const model = resolveGatewayModelSlug(requestedModel, effort, config);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const instructions: string[] = [];
  const input: unknown[] = [];
  let seenConversationMessage = false;

  for (const value of messages) {
    if (typeof value !== "object" || value === null) continue;
    const message = value as Record<string, unknown>;
    const role = message.role;
    if ((role === "system" || role === "developer") && !seenConversationMessage) {
      const text = textParts(message.content).trim();
      if (text) instructions.push(text);
      continue;
    }
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    seenConversationMessage = true;

    if (role === "tool") {
      const output = typeof message.content === "string" ? message.content : textParts(message.content);
      input.push({
        type: "function_call_output",
        call_id: typeof message.tool_call_id === "string" && message.tool_call_id ? message.tool_call_id : "",
        output,
      });
      continue;
    }
    if (role === "assistant") {
      const text = textParts(message.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        if (typeof call !== "object" || call === null) continue;
        const record = call as Record<string, unknown>;
        const fn = record.function as Record<string, unknown> | undefined;
        if (typeof fn?.name !== "string") continue;
        const rawArguments = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        input.push({
          type: "function_call",
          call_id: typeof record.id === "string" && record.id ? record.id : `call_${input.length}_${fn.name}`,
          name: fn.name,
          arguments: rawArguments,
        });
      }
      continue;
    }
    // user
    if (typeof message.content === "string") {
      if (message.content) {
        input.push({ type: "message", role: "user", content: [{ type: "input_text", text: message.content }] });
      }
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const parts: unknown[] = [];
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        parts.push({ type: "input_text", text: record.text });
      } else if (record.type === "image_url") {
        const url = imageUrlOf(record);
        if (url) parts.push({ type: "input_image", image_url: url });
      }
    }
    if (parts.length > 0) input.push({ type: "message", role: "user", content: parts });
  }

  const raw: Record<string, unknown> = {
    model,
    input,
    store: false,
    reasoning: { summary: "auto" },
  };
  if (instructions.length > 0) raw.instructions = instructions.join("\n\n");

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const functionTools: unknown[] = [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const record = tool as Record<string, unknown>;
    const fn = (record.function ?? record) as Record<string, unknown>;
    if (typeof fn.name !== "string" || !fn.name.trim()) continue;
    functionTools.push({
      type: "function",
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: (fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} }) as Record<string, unknown>,
    });
  }
  if (functionTools.length > 0) raw.tools = functionTools;

  const toolChoice = body.tool_choice;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    raw.tool_choice = toolChoice;
  } else if (typeof toolChoice === "object" && toolChoice !== null) {
    const fn = (toolChoice as Record<string, unknown>).function as Record<string, unknown> | undefined;
    if (typeof fn?.name === "string") raw.tool_choice = { type: "function", name: fn.name };
  }
  if (typeof body.parallel_tool_calls === "boolean") raw.parallel_tool_calls = body.parallel_tool_calls;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxTokens === "number") raw.max_output_tokens = maxTokens;
  if (typeof body.temperature === "number") raw.temperature = body.temperature;
  if (typeof body.top_p === "number") raw.top_p = body.top_p;
  if (body.stop !== undefined && body.stop !== null) raw.stop = body.stop;
  if (typeof body.prompt_cache_key === "string") raw.prompt_cache_key = body.prompt_cache_key;
  const responseFormat = body.response_format;
  if (typeof responseFormat === "object" && responseFormat !== null) {
    const format = responseFormat as Record<string, unknown>;
    if (format.type === "json_schema" && typeof format.json_schema === "object" && format.json_schema !== null) {
      const schema = format.json_schema as Record<string, unknown>;
      if (typeof schema.name === "string" && typeof schema.schema === "object") {
        raw.text = {
          format: {
            type: "json_schema",
            name: schema.name,
            strict: schema.strict === true,
            schema: schema.schema,
          },
        };
      }
    }
  }
  return { raw, requestedModel };
}

function usageFromAdapter(usage: CodexUsage | undefined): Record<string, number> {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const completion = usage.outputTokens;
  const prompt = usage.inputTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
  };
}

interface ConcreteToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Terminal view of one turn. Both the streaming and buffered encoders feed every adapter event
 * through `absorb`, so the gateway tool filter runs exactly once per event on either path.
 */
class TurnOutput {
  text = "";
  reasoning = "";
  toolCalls: ConcreteToolCall[] = [];
  usage?: CodexUsage;
  incomplete = false;
  error?: { message: string; status?: number; errorType?: string; code?: string };

  absorb(event: AdapterEvent): void {
    switch (event.type) {
      case "text_delta":
        this.text += event.text;
        break;
      case "thinking_delta":
      case "reasoning_raw_delta":
        this.reasoning += event.type === "thinking_delta" ? event.thinking : event.text;
        break;
      case "tool_call_start":
        this.toolCalls.push({ id: event.id, name: event.name, arguments: "" });
        break;
      case "tool_call_delta": {
        const last = this.toolCalls[this.toolCalls.length - 1];
        if (last) last.arguments += event.arguments;
        break;
      }
      case "done":
        this.usage = event.usage;
        break;
      case "incomplete":
        this.usage = event.usage;
        this.incomplete = true;
        break;
      case "error":
        this.error = {
          message: event.message,
          status: event.status,
          errorType: event.errorType,
          code: event.code,
        };
        break;
      default:
        break;
    }
  }

  get stopReason(): "stop" | "tool_calls" | "length" {
    if (this.toolCalls.length > 0) return "tool_calls";
    return this.incomplete ? "length" : "stop";
  }
}

/** Pass one adapter event through the gateway tool filter, yielding concrete wire-level events. */
function absorbThroughFilter(event: AdapterEvent, filter: GatewayToolCallFilter | undefined): AdapterEvent[] {
  if (!filter) return [event];
  if (event.type === "text_delta") return [...filter.push(event.text)];
  return [event];
}

function gatewayAdapterFactory(adapterFactory: ChatGptWebAdapterFactory): ChatGptWebAdapterFactory {
  // Browser-only gateway turns have no MCP connector surface, so client tools are advertised
  // through the prompt-level contract and the model's sentinel block is parsed back into
  // tool_call events by the filter.
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

function chunkFrame(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export async function chatCompletionsRequest(
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
    return formatErrorResponse(400, "invalid_request_error", "Chat completions request body must be a JSON object");
  }
  let requestedModel = "chatgpt-web";
  let raw: Record<string, unknown>;
  try {
    const translated = translateChatCompletions(body as Record<string, unknown>, config);
    requestedModel = translated.requestedModel;
    raw = translated.raw;
  } catch (error) {
    if (error instanceof GatewayModelError) return formatErrorResponse(error.status, "invalid_request_error", error.message);
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const wantsStream = body && typeof body === "object" && (body as Record<string, unknown>).stream === true;
  raw.stream = false; // The adapter event stream is re-encoded by this handler, never passed through.

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
  const completionId = `chatcmpl-gw${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const output = new TurnOutput();

  const chunkWithToolIndex = (() => {
    let nextToolIndex = 0;
    const emitEvent = (event: AdapterEvent): string | undefined => {
      if (event.type === "text_delta") {
        return chunkFrame(completionId, created, requestedModel, { content: event.text }, null);
      }
      if (event.type === "thinking_delta" || event.type === "reasoning_raw_delta") {
        return chunkFrame(completionId, created, requestedModel, {
          reasoning_content: event.type === "thinking_delta" ? event.thinking : event.text,
        }, null);
      }
      if (event.type === "tool_call_start") {
        const index = nextToolIndex++;
        return chunkFrame(completionId, created, requestedModel, {
          tool_calls: [{ index, id: event.id, type: "function", function: { name: event.name, arguments: "" } }],
        }, null);
      }
      if (event.type === "tool_call_delta") {
        return chunkFrame(completionId, created, requestedModel, {
          tool_calls: [{ index: nextToolIndex - 1, function: { arguments: event.arguments } }],
        }, null);
      }
      return undefined;
    };
    return emitEvent;
  })();

  if (wantsStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (frame: string) => controller.enqueue(encoder.encode(frame));
        send(chunkFrame(completionId, created, requestedModel, { role: "assistant", content: "" }, null));
        try {
          for await (const event of turn.queue) {
            for (const concrete of absorbThroughFilter(event, filter)) {
              output.absorb(concrete);
              const frame = chunkWithToolIndex(concrete);
              if (frame) send(frame);
            }
          }
          await turn.runPromise;
          for (const concrete of filter ? [...filter.flush()] : []) {
            const frame = chunkWithToolIndex(concrete);
            if (frame) send(frame);
          }
        } catch (error) {
          send(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: "server_error", code: null } })}\n\n`);
          controller.close();
          return;
        }
        if (output.error) {
          send(`data: ${JSON.stringify({ error: { message: output.error.message, type: output.error.errorType ?? "server_error", code: output.error.code ?? null } })}\n\n`);
          controller.close();
          return;
        }
        send(chunkFrame(completionId, created, requestedModel, {}, output.stopReason));
        send(`data: ${JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: requestedModel,
          choices: [],
          usage: usageFromAdapter(output.usage),
        })}\n\n`);
        send("data: [DONE]\n\n");
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
    for (const concrete of absorbThroughFilter(event, filter)) output.absorb(concrete);
  }
  for (const concrete of filter ? [...filter.flush()] : []) output.absorb(concrete);
  if (output.error) {
    const status = output.error.status ?? adapterFailureFromMessage(output.error.message).httpStatus;
    return formatErrorResponse(status, output.error.errorType ?? "upstream_error", output.error.message);
  }
  const message: Record<string, unknown> = { role: "assistant" };
  message.content = output.text.length > 0 ? output.text : null;
  if (output.reasoning) message.reasoning_content = output.reasoning;
  if (output.toolCalls.length > 0) {
    message.tool_calls = output.toolCalls.map(call => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  }
  return Response.json({
    id: completionId,
    object: "chat.completion",
    created,
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: output.stopReason }],
    usage: usageFromAdapter(output.usage),
  });
}
