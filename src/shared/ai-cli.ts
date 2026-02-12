/**
 * @module shared/ai-cli
 * @role Resolve agent CLI binaries and execute them via Bun runtime.
 */

import { existsSync } from "fs";
import { delimiter, dirname, join } from "path";

export type AgentCliName = "claude" | "codex";

function unique(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function cliOverrideEnvVar(cli: AgentCliName): string | undefined {
  return cli === "codex" ? process.env.ARISA_CODEX_BIN : process.env.ARISA_CLAUDE_BIN;
}

function candidatePaths(cli: AgentCliName): string[] {
  const bunInstall = process.env.BUN_INSTALL?.trim();
  const bunDir = dirname(process.execPath);
  const fromPath = Bun.which(cli);
  const fromEnvPath = (process.env.PATH || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => join(entry, cli));

  return unique([
    cliOverrideEnvVar(cli),
    bunInstall ? join(bunInstall, "bin", cli) : null,
    join(bunDir, cli),
    fromPath,
    ...fromEnvPath,
  ]);
}

export function resolveAgentCliPath(cli: AgentCliName): string | null {
  for (const candidate of candidatePaths(cli)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function isAgentCliInstalled(cli: AgentCliName): boolean {
  return resolveAgentCliPath(cli) !== null;
}

function resolveRuntime(cli: AgentCliName): string {
  // Claude Code uses Ink which needs Node.js stdin/setRawMode handling;
  // bun crashes with "Raw mode is not supported" even in compat mode
  if (cli === "claude" && Bun.which("node")) return "node";
  return "bun";
}

export function buildBunWrappedAgentCliCommand(cli: AgentCliName, args: string[]): string[] {
  const cliPath = resolveAgentCliPath(cli);
  if (!cliPath) {
    throw new Error(`${cli} CLI not found`);
  }
  return [resolveRuntime(cli), cliPath, ...args];
}
