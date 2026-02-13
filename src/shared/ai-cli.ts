/**
 * @module shared/ai-cli
 * @role Resolve agent CLI binaries and execute them via Bun runtime.
 *       When running as root, wraps calls with su arisa to satisfy
 *       Claude CLI's non-root requirement.
 */

import { existsSync, openSync, readSync, closeSync } from "fs";
import { delimiter, dirname, join } from "path";

export type AgentCliName = "claude" | "codex";

const ARISA_HOME = "/home/arisa";
// Use root's bun — arisa user has traverse+read access via chmod o+x /root, o+rX /root/.bun
const ROOT_BUN_INSTALL = process.env.BUN_INSTALL || "/root/.bun";
const ROOT_BUN_BIN = `${ROOT_BUN_INSTALL}/bin`;
const ARISA_BUN_ENV = `export HOME=${ARISA_HOME} && export BUN_INSTALL=${ROOT_BUN_INSTALL} && export PATH=${ROOT_BUN_BIN}:$PATH`;

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
      join(ROOT_BUN_BIN, cli),
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

// Env vars that must survive the su - login shell reset.
// CLAUDE_CODE_OAUTH_TOKEN is a long-lived (1 year) token from `claude setup-token`
// — the headless auth method. It must be passed through to the CLI.
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

export interface AgentCliOptions {
  /** Skip the ink-shim preload (useful for interactive login flows). Default: false */
  skipPreload?: boolean;
}

/** Env vars to suppress Ink/TTY in non-interactive CLI spawns. Merge into Bun.spawn env. */
export const CLI_SPAWN_ENV: Record<string, string> = { CI: "true", TERM: "dumb" };

/**
 * Detect native executables (Mach-O, ELF) by reading magic bytes.
 * Claude Code CLI v2+ ships as a native binary, not a JS script.
 */
function isNativeBinary(filePath: string): boolean {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    const magic = buf.readUInt32BE(0);
    return (
      magic === 0xCFFAEDFE || // Mach-O 64-bit LE (macOS arm64/x86_64)
      magic === 0xCEFAEDFE || // Mach-O 32-bit LE
      magic === 0xFEEDFACF || // Mach-O 64-bit BE
      magic === 0xFEEDFACE || // Mach-O 32-bit BE
      magic === 0xCAFEBABE || // Mach-O Universal
      magic === 0x7F454C46    // ELF (Linux)
    );
  } catch {
    return false;
  }
}

export function buildBunWrappedAgentCliCommand(cli: AgentCliName, args: string[], options?: AgentCliOptions): string[] {
  const cliPath = isRunningAsRoot()
    ? (resolveAgentCliPath(cli) || join(ROOT_BUN_BIN, cli))
    : resolveAgentCliPath(cli);

  if (!cliPath) {
    throw new Error(`${cli} CLI not found`);
  }

  // Native binaries (Mach-O, ELF) must be executed directly — bun can't parse them as JS
  const native = isNativeBinary(cliPath);

  if (isRunningAsRoot()) {
    // Run as arisa user — Claude CLI refuses to run as root.
    const ciEnv = options?.skipPreload ? "" : "export CI=true && export TERM=dumb && ";
    const inner = native
      ? [cliPath, ...args].map(shellEscape).join(" ")
      : ["bun", "--bun", ...(!options?.skipPreload ? ["--preload", INK_SHIM] : []), cliPath, ...args].map(shellEscape).join(" ");
    // su without "-" preserves parent env (tokens, keys); explicit HOME/PATH for arisa
    return ["su", "arisa", "-s", "/bin/bash", "-c", `${ARISA_BUN_ENV} && ${ciEnv}${buildEnvExports()}${inner}`];
  }

  if (native) {
    return [cliPath, ...args];
  }

  // JS/Node scripts: wrap with bun for performance + optional ink-shim preload
  const preloadArgs = !options?.skipPreload ? ["--preload", INK_SHIM] : [];
  return ["bun", "--bun", ...preloadArgs, cliPath, ...args];
}
