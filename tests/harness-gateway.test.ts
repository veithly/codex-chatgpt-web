import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGatewayStableThreadRequest, synthesizeGatewayTurnContext } from "../src/gateway/turn-context";
import { HARNESS_TARGETS } from "../src/gateway/harness-install";
import { HarnessMcpSessions } from "../src/gateway/harness-mcp";
import { parseRequest } from "../src/responses/parser";

describe("gateway stable-thread marker", () => {
  test("stable threads are marked for retained-conversation reuse", () => {
    const stable: Record<string, unknown> = {
      model: "chatgpt-web/high",
      prompt_cache_key: "harness-session-1",
      input: "hello",
    };
    synthesizeGatewayTurnContext(stable);
    expect(isGatewayStableThreadRequest(stable)).toBeTrue();
    const parsed = parseRequest(stable);
    expect(parsed._rawBody).toBeDefined();

    const ephemeral: Record<string, unknown> = { model: "chatgpt-web/high", input: "hello" };
    synthesizeGatewayTurnContext(ephemeral);
    // Auto-derived threads are stable too, so every gateway turn opts into retained-chat reuse.
    expect(isGatewayStableThreadRequest(ephemeral)).toBeTrue();
    const stableMetadata = JSON.parse(
      (stable.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"] as string,
    ) as { thread_id: string };
    const ephemeralMetadata = JSON.parse(
      (ephemeral.client_metadata as Record<string, unknown>)["x-codex-turn-metadata"] as string,
    ) as { thread_id: string };
    // The explicit prompt_cache_key wins over the auto-derived key.
    expect(stableMetadata.thread_id).toBe("harness-session-1");
    expect(ephemeralMetadata.thread_id).toMatch(/^auto[0-9a-f]{24}$/);
  });

  test("native Codex requests are never marked as gateway turns", () => {
    const native = {
      model: "chatgpt-web/high",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_x", turn_id: "turn_x" }),
      },
    };
    expect(isGatewayStableThreadRequest(native)).toBeFalse();
  });
});

describe("harness mcp sessions", () => {
  test("sessions persist across store instances", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-sessions-"));
    try {
      const path = join(root, "sessions.json");
      const first = new HarnessMcpSessions(path);
      first.set("default", { messages: [{ role: "user", content: "hi" }], updatedAt: 1 });
      const second = new HarnessMcpSessions(path);
      expect(second.get("default")?.messages).toEqual([{ role: "user", content: "hi" }]);
      expect(second.delete("default")).toBeTrue();
      expect(new HarnessMcpSessions(path).get("default")).toBeUndefined();
      expect(readFileSync(path, "utf8").trim()).toBe("{}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("harness install targets", () => {
  test("covers every advertised harness", () => {
    expect([...HARNESS_TARGETS].sort()).toEqual(["claude-code", "omp", "pi", "zcode"]);
  });
});
