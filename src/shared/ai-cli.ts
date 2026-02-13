/**
 * @module shared/ai-cli
 * @role Resolve agent CLI binaries and execute them via Bun runtime.
 *       When running as root, wraps calls with su arisa to satisfy
 *       Claude CLI's non-root requirement.
 */

import { existsSync } from "fs";
import { delimiter, dirname, join } from "path";

export type AgentCliName = "claude" | "codex";

const ARISA_USER_BUN = "/home/arisa/.bun/bin";
const ARISA_INK_SHIM = "/home/arisa/.arisa-ink-shim.js";
const ARISA_HOME = "/home/arisa";
const ARISA_BUN_ENV = `export HOME=${ARISA_HOME} && export BUN_INSTALL=${ARISA_HOME}/.bun && export PATH=${ARISA_USER_BUN}:$PATH`;

export function isRunningAsRoot(): boolean {
  return process.getuid?.() === 0;
}

function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

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
  if (isRunningAsRoot()) {
    // When root, CLIs are installed under arisa user's bun
    return unique([
      cliOverrideEnvVar(cli),
      join(ARISA_USER_BUN, cli),
    ]);
  }

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

const INK_SHIM = join(dirname(new URL(import.meta.url).pathname), "ink-shim.js");

// Env vars that must survive the su - login shell reset
const PASSTHROUGH_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

function buildEnvExports(): string {
  const exports: string[] = [];
  for (const key of PASSTHROUGH_VARS) {
    const val = process.env[key];
    if (val) exports.push(`export ${key}=${shellEscape(val)}`);
  }
  return exports.length > 0 ? exports.join(" && ") + " && " : "";
}

export function buildBunWrappedAgentCliCommand(cli: AgentCliName, args: string[]): string[] {
  if (isRunningAsRoot()) {
    // Run as arisa user — Claude CLI refuses to run as root
    const cliPath = resolveAgentCliPath(cli) || join(ARISA_USER_BUN, cli);
    const shimPath = existsSync(ARISA_INK_SHIM) ? ARISA_INK_SHIM : INK_SHIM;
    const inner = ["bun", "--bun", "--preload", shimPath, cliPath, ...args].map(shellEscape).join(" ");
    // su without "-" preserves parent env (tokens, keys); explicit HOME/PATH for arisa
    return ["su", "arisa", "-s", "/bin/bash", "-c", `${ARISA_BUN_ENV} && ${buildEnvExports()}${inner}`];
  }

  const cliPath = resolveAgentCliPath(cli);
  if (!cliPath) {
    throw new Error(`${cli} CLI not found`);
  }
  // Preload shim that patches process.stdin.setRawMode to prevent Ink crash
  // when running without a TTY (systemd, su -c, etc.)
  return ["bun", "--bun", "--preload", INK_SHIM, cliPath, ...args];
}
