import type { AdapterEvent, CodexTool } from "../types";
import { namespacedToolName } from "../types";

/**
 * Prompt-level tool protocol for gateway turns.
 *
 * Browser-only ChatGPT Web turns are single-shot: the browser model answers from the compiled
 * context and no MCP connector surface exists, so client-side harness tools (Claude Code's
 * Bash/Edit, aider's tools, any OpenAI function tools) cannot execute mid-response. The gateway
 * bridges that gap at the prompt layer: the tool contract travels inside the compiled task context,
 * the model answers with a sentinel-delimited tool invocation block, and the gateway event filter
 * converts that block into standard tool_call adapter events. Tool results return in the next
 * request and are compiled into the context as ordinary tool_result history records, which the
 * envelope already supports.
 *
 * Everything here lives in the gateway layer. Native Codex requests never see the contract or the
 * filter.
 */

export const GATEWAY_TOOL_OPEN = "<<<GW_TOOLS>>>";
export const GATEWAY_TOOL_CLOSE = "<<<END_GW_TOOLS>>>";
const OPEN_SUFFIX_KEEP = GATEWAY_TOOL_OPEN.length - 1;

export function gatewayToolContract(tools: readonly CodexTool[]): string {
  const specs = tools.map(tool => ({
    name: namespacedToolName(tool.namespace, tool.name),
    description: tool.description,
    parameters: tool.parameters,
  }));
  return [
    "<gateway_tool_protocol>",
    "The outer harness exposes client-side tools for this task. You invoke them through a tool invocation block, not through any MCP connector.",
    "To call one or more tools, END YOUR ENTIRE REPLY with exactly one block in this exact format:",
    GATEWAY_TOOL_OPEN,
    '[{"name":"<tool name>","arguments":{...}}, ...]',
    GATEWAY_TOOL_CLOSE,
    "Rules:",
    "1. Call only tools from the provided list, by their exact names. \"arguments\" must be a JSON object matching the tool's parameter schema.",
    "2. The block must be the last thing in the reply. Any prose you want the user to see must come BEFORE the block.",
    "3. After tool results arrive (tool_result records in the task context), continue the task: study the results, call more tools if needed, or produce the final answer.",
    "4. When no tool call is needed, answer directly and never emit the block or an empty one.",
    "5. Never simulate, describe, or fabricate a tool result. Only the outer harness executes tools.",
    "Tool list (JSON):",
    JSON.stringify(specs),
    "</gateway_tool_protocol>",
  ].join("\n");
}

export interface GatewayToolCall {
  id: string;
  name: string;
  arguments: string;
}

function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    const firstBreak = text.indexOf("\n");
    text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
  }
  return text.trim();
}

function parseInvocationBlock(raw: string): Array<{ name: string; arguments: string }> | undefined {
  const text = stripFences(raw);
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const calls: Array<{ name: string; arguments: string }> = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) continue;
    const rawArguments = record.arguments ?? record.parameters ?? record.input ?? record.args;
    calls.push({
      name: record.name.trim(),
      arguments: typeof rawArguments === "string"
        ? rawArguments
        : JSON.stringify(rawArguments ?? {}),
    });
  }
  return calls;
}

/**
 * Incremental text scanner over adapter text deltas. Prose streams through live; the sentinel
 * block is suppressed, parsed, and surfaced as tool_call adapter events. An unterminated or
 * unparseable block degrades to visible prose so nothing the model wrote is silently dropped.
 */
export class GatewayToolCallFilter {
  private buffer = "";
  private collecting = false;
  private collected = "";
  private nextCallId = 1;
  readonly toolCalls: GatewayToolCall[] = [];

  get sawToolCalls(): boolean {
    return this.toolCalls.length > 0;
  }

  *push(delta: string): Generator<AdapterEvent> {
    if (this.collecting) {
      this.collected += delta;
      yield* this.closeCollectedIfNeeded();
      return;
    }
    this.buffer += delta;
    const openIndex = this.buffer.indexOf(GATEWAY_TOOL_OPEN);
    if (openIndex < 0) {
      // Withhold a possible partial sentinel suffix at the buffer tail until more text arrives.
      const keep = Math.min(OPEN_SUFFIX_KEEP, this.buffer.length);
      const emitText = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      if (emitText) yield { type: "text_delta", text: emitText };
      return;
    }
    const prose = this.buffer.slice(0, openIndex);
    if (prose) yield { type: "text_delta", text: prose };
    this.collecting = true;
    this.collected = this.buffer.slice(openIndex + GATEWAY_TOOL_OPEN.length);
    this.buffer = "";
    yield* this.closeCollectedIfNeeded();
  }

  *flush(): Generator<AdapterEvent> {
    if (this.collecting) {
      this.collecting = false;
      const parsed = parseInvocationBlock(this.collected);
      if (parsed === undefined) {
        yield { type: "text_delta", text: `${GATEWAY_TOOL_OPEN}${this.collected}` };
      } else {
        yield* this.emitCalls(parsed);
      }
      this.collected = "";
    }
    if (this.buffer) {
      yield { type: "text_delta", text: this.buffer };
      this.buffer = "";
    }
  }

  private *closeCollectedIfNeeded(): Generator<AdapterEvent> {
    const closeIndex = this.collected.indexOf(GATEWAY_TOOL_CLOSE);
    if (closeIndex < 0) return;
    const block = this.collected.slice(0, closeIndex);
    const tail = this.collected.slice(closeIndex + GATEWAY_TOOL_CLOSE.length);
    this.collected = "";
    this.collecting = false;
    const parsed = parseInvocationBlock(block);
    if (parsed === undefined) {
      yield { type: "text_delta", text: `${GATEWAY_TOOL_OPEN}${block}${GATEWAY_TOOL_CLOSE}` };
    } else {
      yield* this.emitCalls(parsed);
    }
    // The contract ends the reply with the block; any visible trailing prose still streams.
    this.buffer = tail.replace(/^\r?\n/, "");
  }

  private *emitCalls(parsed: Array<{ name: string; arguments: string }>): Generator<AdapterEvent> {
    for (const call of parsed) {
      const id = `gwcall${this.nextCallId}`;
      this.nextCallId += 1;
      this.toolCalls.push({ id, name: call.name, arguments: call.arguments });
      yield { type: "tool_call_start", id, name: call.name };
      if (call.arguments) yield { type: "tool_call_delta", arguments: call.arguments };
      yield { type: "tool_call_end" };
    }
  }
}
