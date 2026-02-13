/**
 * @module daemon/setup
 * @role Interactive first-run setup with inquirer prompts.
 * @responsibilities
 *   - Check required config (TELEGRAM_BOT_TOKEN)
 *   - Check optional config (OPENAI_API_KEY)
 *   - Detect / install missing CLIs (Claude, Codex)
 *   - Run interactive login flows for installed CLIs
 *   - Persist tokens to both .env and encrypted DB
 * @dependencies shared/paths, shared/secrets, shared/ai-cli
 * @effects Reads stdin, writes runtime .env, spawns install/login processes
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { dataDir } from "../shared/paths";
import { secrets, setSecret } from "../shared/secrets";
import { isAgentCliInstalled, buildBunWrappedAgentCliCommand, type AgentCliName } from "../shared/ai-cli";

const ENV_PATH = join(dataDir, ".env");
const SETUP_DONE_KEY = "ARISA_SETUP_COMPLETE";

const CLI_PACKAGES: Record<AgentCliName, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

function loadExistingEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

function saveEnv(vars: Record<string, string>) {
  const dir = dirname(ENV_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(ENV_PATH, content);
}

// Robust readline that survives after child processes inherit stdin
async function readLine(question: string): Promise<string> {
  const rl = await import("node:readline");
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    iface.question(question, (answer) => {
      iface.close();
      resolve(answer.trim());
    });
  });
}

export async function runSetup(): Promise<boolean> {
  const vars = loadExistingEnv();
  const telegramSecret = await secrets.telegram();
  const openaiSecret = await secrets.openai();
  let changed = false;
  const setupDone = vars[SETUP_DONE_KEY] === "1" || process.env[SETUP_DONE_KEY] === "1";
  const isFirstRun = !setupDone;

  // Try to load inquirer for interactive mode
  let inq: typeof import("@inquirer/prompts") | null = null;
  if (process.stdin.isTTY) {
    try {
      inq = await import("@inquirer/prompts");
    } catch {
      // Fall back to basic prompts
    }
  }

  // ─── Phase 1: Tokens ────────────────────────────────────────────

  const hasTelegram = !!(vars.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || telegramSecret);
  const hasOpenAI = !!(vars.OPENAI_API_KEY || process.env.OPENAI_API_KEY || openaiSecret);

  if (!hasTelegram) {
    if (isFirstRun) console.log("\n🔧 Arisa Setup\n");

    let token: string;
    if (inq) {
      token = await inq.input({
        message: "Telegram Bot Token (from https://t.me/BotFather):",
        validate: (v) => (v.trim() ? true : "Token is required"),
      });
    } else {
      console.log("Telegram Bot Token required. Get one from https://t.me/BotFather on Telegram.");
      token = await readLine("TELEGRAM_BOT_TOKEN: ");
    }

    if (!token.trim()) {
      console.log("No token provided. Cannot start without Telegram Bot Token.");
      return false;
    }

    vars.TELEGRAM_BOT_TOKEN = token.trim();
    await setSecret("TELEGRAM_BOT_TOKEN", token.trim()).catch((e) =>
      console.warn(`[setup] Could not persist TELEGRAM_BOT_TOKEN to encrypted DB: ${e}`)
    );
    console.log("[setup] TELEGRAM_BOT_TOKEN saved to .env + encrypted DB");
    changed = true;
  } else {
    const src = telegramSecret ? "encrypted DB" : vars.TELEGRAM_BOT_TOKEN ? ".env" : "env var";
    console.log(`[setup] TELEGRAM_BOT_TOKEN found in ${src}`);
  }

  if (!hasOpenAI && isFirstRun) {
    let key: string;
    if (inq) {
      key = await inq.input({
        message: "OpenAI API Key (optional — voice + image, enter to skip):",
      });
    } else {
      console.log("\nOpenAI API Key (optional — enables voice transcription + image analysis).");
      key = await readLine("OPENAI_API_KEY (enter to skip): ");
    }

    if (key.trim()) {
      vars.OPENAI_API_KEY = key.trim();
      await setSecret("OPENAI_API_KEY", key.trim()).catch((e) =>
        console.warn(`[setup] Could not persist OPENAI_API_KEY to encrypted DB: ${e}`)
      );
      console.log("[setup] OPENAI_API_KEY saved to .env + encrypted DB");
      changed = true;
    }
  } else if (hasOpenAI) {
    const src = openaiSecret ? "encrypted DB" : vars.OPENAI_API_KEY ? ".env" : "env var";
    console.log(`[setup] OPENAI_API_KEY found in ${src}`);
  }

  // Save tokens
  if (!setupDone) {
    vars[SETUP_DONE_KEY] = "1";
    changed = true;
  }
  if (changed) {
    saveEnv(vars);
    console.log(`\nConfig saved to ${ENV_PATH}`);
  }

  // ─── Phase 2: CLI Installation + Auth ───────────────────────────

  if (process.stdin.isTTY) {
    if (isFirstRun) {
      // First run: offer to install missing CLIs + login
      await setupClis(inq, vars);
    } else {
      // Subsequent runs: check if any installed CLI needs auth, offer login
      await checkCliAuth(inq, vars);
    }
  }

  return true;
}

async function setupClis(inq: typeof import("@inquirer/prompts") | null, vars: Record<string, string>) {
  let claudeInstalled = isAgentCliInstalled("claude");
  let codexInstalled = isAgentCliInstalled("codex");

  console.log("\nCLI Status:");
  console.log(`  ${claudeInstalled ? "✓" : "✗"} Claude${claudeInstalled ? "" : " — not installed"}`);
  console.log(`  ${codexInstalled ? "✓" : "✗"} Codex${codexInstalled ? "" : " — not installed"}`);

  // Install missing CLIs
  const missing: AgentCliName[] = [];
  if (!claudeInstalled) missing.push("claude");
  if (!codexInstalled) missing.push("codex");

  if (missing.length > 0) {
    let toInstall: AgentCliName[] = [];

    if (inq) {
      toInstall = await inq.checkbox({
        message: "Install missing CLIs? (space to select, enter to confirm)",
        choices: missing.map((cli) => ({
          name: `${cli === "claude" ? "Claude" : "Codex"} (${CLI_PACKAGES[cli]})`,
          value: cli as AgentCliName,
          checked: true,
        })),
      });
    } else {
      // Non-inquirer fallback: install all
      const answer = await readLine("\nInstall missing CLIs? (Y/n): ");
      if (answer.toLowerCase() !== "n") toInstall = missing;
    }

    for (const cli of toInstall) {
      console.log(`\nInstalling ${cli}...`);
      const ok = await installCli(cli);
      console.log(ok ? `  ✓ ${cli} installed` : `  ✗ ${cli} install failed`);
    }

    // Refresh status
    claudeInstalled = isAgentCliInstalled("claude");
    codexInstalled = isAgentCliInstalled("codex");
  }

  // Login CLIs
  if (claudeInstalled) {
    let doLogin = true;
    if (inq) {
      doLogin = await inq.confirm({ message: "Log in to Claude?", default: true });
    } else {
      const answer = await readLine("\nLog in to Claude? (Y/n): ");
      doLogin = answer.toLowerCase() !== "n";
    }
    if (doLogin) {
      console.log();
      await runInteractiveLogin("claude", vars);
    }
  }

  if (codexInstalled) {
    let doLogin = true;
    if (inq) {
      doLogin = await inq.confirm({ message: "Log in to Codex?", default: true });
    } else {
      const answer = await readLine("\nLog in to Codex? (Y/n): ");
      doLogin = answer.toLowerCase() !== "n";
    }
    if (doLogin) {
      console.log();
      await runInteractiveLogin("codex", vars);
    }
  }

  if (!claudeInstalled && !codexInstalled) {
    console.log("\n⚠ No CLIs installed. Arisa needs at least one to work.");
    console.log("  The daemon will auto-install them in the background.\n");
  } else {
    console.log("\n✓ Setup complete!\n");
  }
}

/**
 * On non-first runs, check if installed CLIs are authenticated.
 * If not, offer to login interactively.
 */
async function checkCliAuth(inq: typeof import("@inquirer/prompts") | null, vars: Record<string, string>) {
  const clis: AgentCliName[] = [];
  if (isAgentCliInstalled("claude")) clis.push("claude");
  if (isAgentCliInstalled("codex")) clis.push("codex");
  if (clis.length === 0) return;

  for (const cli of clis) {
    const authed = await isCliAuthenticated(cli);
    if (authed) {
      console.log(`[setup] ${cli} ✓ authenticated`);
      continue;
    }

    console.log(`[setup] ${cli} ✗ not authenticated`);
    let doLogin = true;
    if (inq) {
      doLogin = await inq.confirm({ message: `Log in to ${cli === "claude" ? "Claude" : "Codex"}?`, default: true });
    } else {
      const answer = await readLine(`\nLog in to ${cli === "claude" ? "Claude" : "Codex"}? (Y/n): `);
      doLogin = answer.toLowerCase() !== "n";
    }
    if (doLogin) {
      console.log();
      await runInteractiveLogin(cli, vars);
    }
  }
}

/**
 * Quick probe: is this CLI authenticated?
 * Claude: check CLAUDE_CODE_OAUTH_TOKEN env/.env, or `claude auth status`
 * Codex: no simple auth check, assume OK if installed
 */
async function isCliAuthenticated(cli: AgentCliName): Promise<boolean> {
  try {
    if (cli === "claude") {
      // setup-token auth: token lives in env var (not .credentials.json)
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.startsWith("sk-ant-")) {
        console.log(`[setup] claude auth via CLAUDE_CODE_OAUTH_TOKEN env var`);
        return true;
      }
      // Native CLI auth: check `claude auth status`
      const cmd = buildBunWrappedAgentCliCommand("claude", ["auth", "status"], { skipPreload: true });
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return exitCode === 0 && stdout.includes('"loggedIn": true');
    }
    // Codex: no simple auth check, assume OK if installed
    return true;
  } catch {
    return false;
  }
}

async function installCli(cli: AgentCliName): Promise<boolean> {
  try {
    // Install into root's bun (arisa has read+execute access)
    const cmd = ["bun", "add", "-g", CLI_PACKAGES[cli]];
    const proc = Bun.spawn(cmd, {
      stdout: "inherit",
      stderr: "inherit",
    });
    const timeout = setTimeout(() => proc.kill(), 180_000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    return exitCode === 0;
  } catch (e) {
    console.error(`  Install error: ${e}`);
    return false;
  }
}


async function runInteractiveLogin(cli: AgentCliName, vars: Record<string, string>): Promise<boolean> {
  const args = cli === "claude"
    ? ["setup-token"]
    : ["login", "--device-auth"];

  console.log(`Starting ${cli} login...`);

  try {
    const proc = Bun.spawn(buildBunWrappedAgentCliCommand(cli, args, { skipPreload: true }), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.log(`  ✗ ${cli} login failed (exit ${exitCode})`);
      return false;
    }

    console.log(`  ✓ ${cli} login successful`);

    // `claude setup-token` prints a token but does NOT store it.
    // Ask the user to paste it.
    if (cli === "claude") {
      console.log("\n  Paste the token shown above (starts with sk-ant-):");
      const token = (await readLine("  > ")).trim();
      if (token.startsWith("sk-ant-") && token.length > 80) {
        vars.CLAUDE_CODE_OAUTH_TOKEN = token;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
        saveEnv(vars);
        console.log(`  ✓ token saved to .env (${token.length} chars)`);
      } else if (token) {
        // Save it anyway, user knows best
        vars.CLAUDE_CODE_OAUTH_TOKEN = token;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
        saveEnv(vars);
        console.log(`  ⚠ token saved (${token.length} chars) — verify it works`);
      } else {
        console.log("  ⚠ no token — set CLAUDE_CODE_OAUTH_TOKEN in ~/.arisa/.env");
      }
    }

    return true;
  } catch (e) {
    console.error(`  Login error: ${e}`);
    return false;
  }
}
