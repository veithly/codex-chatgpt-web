import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version";

/**
 * One-command MCP registration for every local harness (`codex-chatgpt-web harness install`).
 *
 * Writes the harness-face MCP server (`harness serve`) into each harness's own config file with a
 * minimal, merge-only edit: existing entries are never touched, and a `.pre-harness-<version>`
 * backup of the file is kept next to it. The registered command points at the durable packaged
 * runtime (never a temporary AppImage mount or the launcher process) so the entry survives
 * launcher updates until the version directory it pins is replaced.
 */

export type HarnessTarget = "claude-code" | "zcode" | "pi" | "omp";

export const HARNESS_TARGETS: readonly HarnessTarget[] = ["claude-code", "zcode", "pi", "omp"];

const SERVER_KEY = "codex-chatgpt-web";

interface JsonTarget {
  id: HarnessTarget;
  label: string;
  configFile: string;
  /** Build the (mutated) config object for install; returns the entry it wrote. */
  apply: (config: Record<string, unknown>, entry: Record<string, unknown>) => void;
  /** Remove the entry; returns true when something was removed. */
  remove: (config: Record<string, unknown>) => boolean;
  /** True when this harness looks installed on this machine. */
  detect: (config: Record<string, unknown> | undefined) => boolean;
}

function expand(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function serverObjectMap(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  let value = parent[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    value = {};
    parent[key] = value;
  }
  return value as Record<string, unknown>;
}

/**
 * Resolve the durable packaged runtime entry for the MCP server. Prefers the newest
 * `versions/<release>/` directory (the launcher's verified durable copy); falls back to a
 * `codex-chatgpt-web` binary on PATH for terminal-only installations.
 */
export function harnessServeEntry(): { command: string; args: string[] } {
  const versionsRoot = expand("~/.codex-chatgpt-web/versions");
  const candidates: string[] = [];
  try {
    if (existsSync(versionsRoot)) candidates.push(...readdirSync(versionsRoot));
  } catch {
    // Fall through to the PATH fallback.
  }
  for (const dir of candidates.sort().reverse()) {
    if (!dir.includes(VERSION)) continue;
    const bun = join(versionsRoot, dir, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
    const cli = join(versionsRoot, dir, "app", "cli.js");
    if (existsSync(bun) && existsSync(cli)) return { command: bun, args: [cli, "harness", "serve"] };
  }
  for (const dir of candidates.sort().reverse()) {
    const bun = join(versionsRoot, dir, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
    const cli = join(versionsRoot, dir, "app", "cli.js");
    if (existsSync(bun) && existsSync(cli)) return { command: bun, args: [cli, "harness", "serve"] };
  }
  return { command: "codex-chatgpt-web", args: ["harness", "serve"] };
}

function targetDefinitions(): JsonTarget[] {
  const claudeConfig = expand("~/.claude.json");
  const zcodeConfig = expand("~/.zcode/cli/config.json");
  const piConfig = expand("~/.pi/agent/settings.json");
  const ompConfig = expand("~/.omp/agent/mcp.json");
  return [
    {
      id: "claude-code",
      label: "Claude Code (~/.claude.json)",
      configFile: claudeConfig,
      detect: config => config !== undefined,
      apply: (config, entry) => {
        serverObjectMap(config, "mcpServers")[SERVER_KEY] = entry;
      },
      remove: config => {
        const servers = config.mcpServers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
        return delete (servers as Record<string, unknown>)[SERVER_KEY];
      },
    },
    {
      id: "zcode",
      label: "ZCode (~/.zcode/cli/config.json)",
      configFile: zcodeConfig,
      detect: config => config !== undefined,
      apply: (config, entry) => {
        const mcp = serverObjectMap(config, "mcp");
        serverObjectMap(mcp, "servers")[SERVER_KEY] = { type: "stdio", ...entry };
      },
      remove: config => {
        const mcp = config.mcp;
        if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return false;
        const servers = (mcp as Record<string, unknown>).servers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
        return delete (servers as Record<string, unknown>)[SERVER_KEY];
      },
    },
    {
      id: "omp",
      label: "Oh My Pi (~/.omp/agent/mcp.json)",
      configFile: ompConfig,
      detect: config => config !== undefined,
      apply: (config, entry) => {
        serverObjectMap(config, "mcpServers")[SERVER_KEY] = { type: "stdio", ...entry };
      },
      remove: config => {
        const servers = config.mcpServers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
        return delete (servers as Record<string, unknown>)[SERVER_KEY];
      },
    },
    {
      id: "pi",
      label: "Pi (~/.pi/agent/settings.json)",
      configFile: piConfig,
      detect: config => config !== undefined,
      apply: (config, entry) => {
        serverObjectMap(config, "mcpServers")[SERVER_KEY] = entry;
      },
      remove: config => {
        const servers = config.mcpServers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
        return delete (servers as Record<string, unknown>)[SERVER_KEY];
      },
    },
  ];
}

export interface HarnessInstallReport {
  target: HarnessTarget;
  status: "installed" | "removed" | "already-absent" | "harness-not-detected" | "config-unavailable";
  configPath: string;
}

function writeTarget(
  target: JsonTarget,
  mutate: (config: Record<string, unknown>) => boolean,
  mutatedStatus: HarnessInstallReport["status"] = "installed",
): HarnessInstallReport {
  const original = readJsonObject(target.configFile);
  if (original === undefined && !existsSync(target.configFile) && !target.detect(undefined)) {
    return { target: target.id, status: "harness-not-detected", configPath: target.configFile };
  }
  const config = original ?? {};
  if (!mutate(config)) {
    return { target: target.id, status: "already-absent", configPath: target.configFile };
  }
  if (existsSync(target.configFile)) {
    renameSync(target.configFile, `${target.configFile}.pre-harness-${VERSION}`);
  }
  writeFileSync(target.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { target: target.id, status: mutatedStatus, configPath: target.configFile };
}

export function installHarness(target: HarnessTarget): HarnessInstallReport {
  const definition = targetDefinitions().find(t => t.id === target)!;
  const entry = harnessServeEntry();
  return writeTarget(definition, config => {
    definition.apply(config, entry);
    return true;
  });
}

export function removeHarness(target: HarnessTarget): HarnessInstallReport {
  const definition = targetDefinitions().find(t => t.id === target)!;
  return writeTarget(definition, config => definition.remove(config), "removed");
}

export function listHarnessTargets(): Array<{
  id: HarnessTarget;
  label: string;
  detected: boolean;
  installed: boolean;
  configFile: string;
}> {
  return targetDefinitions().map(definition => {
    const config = readJsonObject(definition.configFile);
    return {
      id: definition.id,
      label: definition.label,
      detected: config !== undefined,
      installed: config !== undefined && configContainsEntry(config, definition),
      configFile: definition.configFile,
    };
  });
}

function configContainsEntry(config: Record<string, unknown>, definition: JsonTarget): boolean {
  if (definition.id === "zcode") {
    const mcp = config.mcp as Record<string, unknown> | undefined;
    const servers = mcp?.servers as Record<string, unknown> | undefined;
    return Boolean(servers?.[SERVER_KEY]);
  }
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  return Boolean(servers?.[SERVER_KEY]);
}
