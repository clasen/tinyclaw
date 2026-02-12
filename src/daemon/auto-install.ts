/**
 * @module daemon/auto-install
 * @role Auto-install missing AI CLIs at daemon startup.
 * @responsibilities
 *   - Check which CLIs (claude, codex) are missing
 *   - Attempt `bun add -g <package>` for each missing CLI
 *   - Log results, notify chats on success
 * @dependencies shared/ai-cli
 * @effects Spawns bun install processes, modifies global packages
 */

import { createLogger } from "../shared/logger";
import { isAgentCliInstalled, buildBunWrappedAgentCliCommand, type AgentCliName } from "../shared/ai-cli";

const log = createLogger("daemon");

const CLI_PACKAGES: Record<AgentCliName, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

const INSTALL_TIMEOUT = 120_000; // 2min

type NotifyFn = (text: string) => Promise<void>;
let notifyFn: NotifyFn | null = null;

export function setAutoInstallNotify(fn: NotifyFn) {
  notifyFn = fn;
}

async function installCli(cli: AgentCliName): Promise<boolean> {
  const pkg = CLI_PACKAGES[cli];
  log.info(`Auto-install: installing ${cli} (${pkg})...`);

  try {
    const proc = Bun.spawn(["bun", "add", "-g", pkg], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const timeout = setTimeout(() => proc.kill(), INSTALL_TIMEOUT);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode === 0) {
      log.info(`Auto-install: ${cli} installed successfully`);
      return true;
    } else {
      const stderr = await new Response(proc.stderr).text();
      log.error(`Auto-install: ${cli} install failed (exit ${exitCode}): ${stderr.slice(0, 300)}`);
      return false;
    }
  } catch (error) {
    log.error(`Auto-install: ${cli} install error: ${error}`);
    return false;
  }
}

export async function autoInstallMissingClis(): Promise<void> {
  const missing: AgentCliName[] = [];

  for (const cli of Object.keys(CLI_PACKAGES) as AgentCliName[]) {
    if (!isAgentCliInstalled(cli)) {
      missing.push(cli);
    }
  }

  if (missing.length === 0) {
    log.info("Auto-install: all CLIs already installed");
    return;
  }

  log.info(`Auto-install: missing CLIs: ${missing.join(", ")}`);

  const installed: string[] = [];
  for (const cli of missing) {
    const ok = await installCli(cli);
    if (ok) installed.push(cli);
  }

  if (installed.length > 0) {
    const msg = `Auto-installed: <b>${installed.join(", ")}</b>`;
    log.info(msg);
    await notifyFn?.(msg).catch((e) => log.error(`Auto-install notify failed: ${e}`));
  }

  // After install, probe auth for all installed CLIs
  await probeCliAuth();
}

type AuthProbeFn = (cli: AgentCliName, errorText: string) => void;
let authProbeFn: AuthProbeFn | null = null;

export function setAuthProbeCallback(fn: AuthProbeFn) {
  authProbeFn = fn;
}

const PROBE_TIMEOUT = 15_000;

/**
 * Run a minimal command with each installed CLI to detect auth errors early.
 * Uses a real API call (cheap haiku / short exec) so auth errors surface.
 * When an auth error is found, the callback triggers the appropriate login flow.
 */
export async function probeCliAuth(): Promise<void> {
  for (const cli of ["claude", "codex"] as AgentCliName[]) {
    if (!isAgentCliInstalled(cli)) continue;

    log.info(`Auth probe: testing ${cli}...`);
    if (cli === "claude") {
      const hasToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const tokenPreview = hasToken ? `${process.env.CLAUDE_CODE_OAUTH_TOKEN!.slice(0, 15)}...` : "NOT SET";
      log.info(`Auth probe: CLAUDE_CODE_OAUTH_TOKEN=${tokenPreview}`);
    }
    try {
      const args = cli === "claude"
        ? ["-p", "say ok", "--model", "haiku", "--dangerously-skip-permissions"]
        : ["exec", "--dangerously-bypass-approvals-and-sandbox", "echo ok"];

      const cmd = buildBunWrappedAgentCliCommand(cli, args);
      log.info(`Auth probe cmd: ${cmd.map(c => c.length > 80 ? c.slice(0, 80) + "..." : c).join(" ")}`);

      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });

      const timeout = setTimeout(() => proc.kill(), PROBE_TIMEOUT);
      const exitCode = await proc.exited;
      clearTimeout(timeout);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode === 0) {
        log.info(`Auth probe: ${cli} authenticated OK`);
      } else {
        const combined = stdout + "\n" + stderr;
        log.warn(`Auth probe: ${cli} failed (exit ${exitCode}): ${combined.slice(0, 200)}`);
        authProbeFn?.(cli, combined);
      }
    } catch (e) {
      log.error(`Auth probe: ${cli} error: ${e}`);
    }
  }
}
