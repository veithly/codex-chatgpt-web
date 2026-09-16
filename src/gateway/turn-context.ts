import { createHash } from "node:crypto";

/**
 * Open-harness gateway turn synthesis.
 *
 * The browser adapter's authority chain requires native Codex turn metadata
 * (client_metadata["x-codex-turn-metadata"]) plus a current-turn user message tagged with that
 * turn id. Native Codex always supplies both. Any other harness — a raw OpenAI Responses client,
 * the OpenAI Chat Completions translation, or the Anthropic Messages translation — supplies
 * neither, so the gateway synthesizes an equivalent identity instead of failing closed.
 *
 * Requests that already carry turn metadata are never touched: native Codex behavior,
 * including its strict revision-conflict validation, is preserved byte-for-byte.
 */

const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

export interface GatewayTurnSynthesis {
  threadId: string;
  turnId: string;
  /** Deterministic per-user-message ids were assigned from a client-supplied stable thread key. */
  stableThread: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasClientTurnMetadata(body: Record<string, unknown>): boolean {
  const metadata = body.client_metadata;
  if (!isRecord(metadata)) return false;
  return metadata["x-codex-turn-metadata"] !== undefined;
}

function stableThreadKey(body: Record<string, unknown>): string | undefined {
  const key = body.prompt_cache_key;
  if (typeof key !== "string") return undefined;
  const trimmed = key.trim();
  return THREAD_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

function gatewayUserTurnId(threadId: string, text: string): string {
  const digest = createHash("sha256").update(`${threadId}\u0000${text}`).digest("hex");
  return `gwturn${digest.slice(0, 24)}`;
}

function rawItemText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map(part => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .join("\n");
}

function tagUserItem(item: Record<string, unknown>, turnId: string): void {
  item.internal_chat_message_metadata_passthrough = {
    ...(isRecord(item.internal_chat_message_metadata_passthrough)
      ? item.internal_chat_message_metadata_passthrough
      : {}),
    turn_id: turnId,
  };
  if (typeof item.id !== "string" || !item.id) item.id = `msg_${turnId}`;
}

function tagAssistantItem(item: Record<string, unknown>, turnId: string): void {
  item.internal_chat_message_metadata_passthrough = {
    ...(isRecord(item.internal_chat_message_metadata_passthrough)
      ? item.internal_chat_message_metadata_passthrough
      : {}),
    turn_id: turnId,
  };
}

/**
 * Synthesize gateway turn identity in place. Returns the synthesis when the body had no Codex
 * turn metadata (the caller must then run the turn with browser-only capabilities), and undefined
 * when the body already carries native Codex authority.
 *
 * With a valid `prompt_cache_key`, the thread key is stable across requests and every user message
 * receives a deterministic turn id (keyed by thread + message text). That lets the Luna rolling
 * checkpoint store match the exact parent assistant answer across harness turns. Without one, each
 * request is an independent thread: only the final user message is tagged, and no cross-request
 * state is ever reused.
 */
export function synthesizeGatewayTurnContext(body: Record<string, unknown>): GatewayTurnSynthesis | undefined {
  if (hasClientTurnMetadata(body)) return undefined;
  const stableKey = stableThreadKey(body);
  const threadId = stableKey ?? `gw${crypto.randomUUID().replaceAll("-", "")}`;
  const input = Array.isArray(body.input) ? body.input : undefined;
  let turnId: string;

  if (!input) {
    // String (or absent) input: normalize to one tagged user message item so the adapter's
    // current-turn user revision is discoverable in the raw body.
    const text = typeof body.input === "string" ? body.input : "";
    turnId = stableKey ? gatewayUserTurnId(threadId, text) : `gwturn${crypto.randomUUID().replaceAll("-", "")}`;
    body.input = [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
      id: `msg_${turnId}`,
    }];
  } else {
    let lastUserIndex = -1;
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (isRecord(item) && item.type === "message" && item.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    if (stableKey) {
      // Deterministic ids: replaying the same conversation always tags the same messages with the
      // same turn ids, which is what the exact-parent Luna checkpoint matching requires.
      let activeTurnId: string | undefined;
      for (let index = 0; index < input.length; index += 1) {
        const item = input[index];
        if (!isRecord(item) || item.type !== "message") continue;
        if (item.role === "user") {
          activeTurnId = gatewayUserTurnId(threadId, rawItemText(item));
          tagUserItem(item, activeTurnId);
        } else if (item.role === "assistant" && activeTurnId) {
          tagAssistantItem(item, activeTurnId);
        }
      }
      turnId = activeTurnId ?? `gwturn${crypto.randomUUID().replaceAll("-", "")}`;
    } else {
      turnId = `gwturn${crypto.randomUUID().replaceAll("-", "")}`;
      if (lastUserIndex >= 0) tagUserItem(input[lastUserIndex] as Record<string, unknown>, turnId);
    }
    if (lastUserIndex < 0) {
      // No user message at all: the adapter requires a canonical user instruction. The final
      // synthetic instruction keeps the turn well-formed without inventing conversation content.
      const instruction = "Continue the conversation.";
      turnId = `gwturn${crypto.randomUUID().replaceAll("-", "")}`;
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: instruction }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
        id: `msg_${turnId}`,
      });
    }
  }

  const existingMetadata = isRecord(body.client_metadata) ? body.client_metadata : {};
  body.client_metadata = {
    ...existingMetadata,
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: threadId,
      turn_id: turnId,
      request_kind: "turn",
      sandbox: "none",
    }),
    // Marks this request as gateway-authored. A stable thread opts sequential requests into
    // retained-conversation reuse (same browser chat, incremental prompts) instead of one fresh
    // Temporary Chat per request.
    "x-chatgpt-web-gateway": { ...(isRecord(existingMetadata["x-chatgpt-web-gateway"]) ? existingMetadata["x-chatgpt-web-gateway"] : {}), stable_thread: stableKey !== undefined },
  };
  return { threadId, turnId, stableThread: stableKey !== undefined };
}

/** True when this request was gateway-synthesized with a client-supplied stable thread key. */
export function isGatewayStableThreadRequest(value: unknown): boolean {
  const body = isRecord(value) ? value : undefined;
  const metadata = isRecord(body?.client_metadata) ? body.client_metadata : undefined;
  const marker = metadata?.["x-chatgpt-web-gateway"];
  return isRecord(marker) && marker.stable_thread === true;
}
