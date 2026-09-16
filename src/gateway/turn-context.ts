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

function stableThreadKey(body: Record<string, unknown>): string {
  const key = body.prompt_cache_key;
  if (typeof key === "string") {
    const trimmed = key.trim();
    if (THREAD_ID_PATTERN.test(trimmed)) return trimmed;
  }
  // No client-supplied session key: derive one deterministically from the conversation's stable
  // head (model + instructions + first user message). Requests that belong to the same harness
  // conversation produce the same key as the history grows, so they reuse one browser chat;
  // genuinely different conversations almost always differ in their first user message and map to
  // separate threads.
  const input = Array.isArray(body.input) ? body.input : [];
  let firstUserText = typeof body.input === "string" ? body.input : "";
  for (const item of input) {
    if (isRecord(item) && item.type === "message" && item.role === "user") {
      firstUserText = rawItemText(item);
      break;
    }
  }
  const digest = createHash("sha256")
    .update([
      typeof body.model === "string" ? body.model : "",
      typeof body.instructions === "string" ? body.instructions : "",
      firstUserText,
    ].join("\u0000"))
    .digest("hex");
  return `auto${digest.slice(0, 24)}`;
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
 * Every gateway request gets a stable thread key — the client's `prompt_cache_key` when present,
 * otherwise one derived from the conversation's stable head (model + instructions + first user
 * message). User and assistant messages receive deterministic turn ids keyed by thread + message
 * text, so sequential requests of one conversation keep their identity across replay: the adapter
 * reuses the retained browser chat for follow-ups, and Luna's rolling checkpoint store matches the
 * exact parent assistant answer. Clients that want an isolated conversation should send a unique
 * `prompt_cache_key` (or change the conversation head).
 */
export function synthesizeGatewayTurnContext(body: Record<string, unknown>): GatewayTurnSynthesis | undefined {
  if (hasClientTurnMetadata(body)) return undefined;
  const threadId = stableThreadKey(body);
  const input = Array.isArray(body.input) ? body.input : undefined;
  let turnId: string;

  if (!input) {
    // String (or absent) input: normalize to one tagged user message item so the adapter's
    // current-turn user revision is discoverable in the raw body.
    const text = typeof body.input === "string" ? body.input : "";
    turnId = gatewayUserTurnId(threadId, text);
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
    // Marks this request as gateway-authored with a stable thread, which opts sequential requests
    // into retained-conversation reuse (same browser chat, incremental prompts) instead of one
    // fresh Temporary Chat per request.
    "x-chatgpt-web-gateway": { ...(isRecord(existingMetadata["x-chatgpt-web-gateway"]) ? existingMetadata["x-chatgpt-web-gateway"] : {}), stable_thread: true },
  };
  return { threadId, turnId, stableThread: true };
}

/** True when this request was gateway-synthesized with a stable thread (always true for gateway turns). */
export function isGatewayStableThreadRequest(value: unknown): boolean {
  const body = isRecord(value) ? value : undefined;
  const metadata = isRecord(body?.client_metadata) ? body.client_metadata : undefined;
  const marker = metadata?.["x-chatgpt-web-gateway"];
  return isRecord(marker) && marker.stable_thread === true;
}
