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
import { isAgentCliInstalled, buildBunWrappedAgentCliCommand, isRunningAsRoot, type AgentCliName } from "../shared/ai-cli";

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

// Fallback readline for non-TTY environments
async function readLine(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
  return "";
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

  // ─── Phase 2: CLI Installation (first run, interactive) ─────────

  if (isFirstRun && process.stdin.isTTY) {
    await setupClis(inq, vars);
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

async function installCli(cli: AgentCliName): Promise<boolean> {
  try {
    const cmd = isRunningAsRoot()
      ? ["su", "-", "arisa", "-c", `export BUN_INSTALL=/home/arisa/.bun && export PATH=/home/arisa/.bun/bin:$PATH && bun add -g ${CLI_PACKAGES[cli]}`]
      : ["bun", "add", "-g", CLI_PACKAGES[cli]];
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
    // For claude: capture stdout to extract OAuth token while still showing output
    if (cli === "claude") {
      const proc = Bun.spawn(buildBunWrappedAgentCliCommand(cli, args), {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "inherit",
      });

      let output = "";
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        process.stdout.write(chunk);
        output += chunk;
      }

      const exitCode = await proc.exited;
      if (exitCode === 0) {
        // Strip ANSI with a state machine (regex can't handle all Ink sequences)
        function stripAnsi(s: string): string {
          let out = "";
          for (let i = 0; i < s.length; i++) {
            if (s.charCodeAt(i) === 0x1b) {
              i++;
              if (i >= s.length) break;
              if (s[i] === "[") {
                // CSI: ESC [ <params 0x20-0x3F>* <final 0x40-0x7E>
                i++;
                while (i < s.length && s.charCodeAt(i) < 0x40) i++;
                // i now on final byte, loop will i++
              } else if (s[i] === "]") {
                // OSC: ESC ] ... BEL(0x07) or ST(ESC \)
                i++;
                while (i < s.length && s.charCodeAt(i) !== 0x07 && s[i] !== "\x1b") i++;
              } else if (s[i] === "(" || s[i] === ")" || s[i] === "#") {
                i++; // skip designator byte
              }
              // else: 2-byte Fe sequence, already skipped
            } else if (s.charCodeAt(i) < 0x20 && s[i] !== "\n" && s[i] !== "\r") {
              // skip control chars
            } else {
              out += s[i];
            }
          }
          return out;
        }

        const clean = stripAnsi(output);
        const startIdx = clean.indexOf("sk-ant-");
        let token = "";

        if (startIdx >= 0) {
          let endIdx = clean.indexOf("Store", startIdx);
          if (endIdx < 0) endIdx = clean.indexOf("Use this", startIdx);
          if (endIdx < 0) endIdx = startIdx + 200;

          const tokenArea = clean.substring(startIdx, endIdx);
          token = tokenArea.replace(/[^A-Za-z0-9_-]/g, "");
        }

        if (token && token.startsWith("sk-ant-") && token.length > 50 && token.length < 150) {
          console.log(`  [token] ${token.slice(0, 20)}...${token.slice(-6)} (${token.length} chars)`);
          vars.CLAUDE_CODE_OAUTH_TOKEN = token;
          process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
          saveEnv(vars);
          console.log("  ✓ claude token saved to .env");

          // Also write credentials file for arisa user (belt + suspenders)
          const claudeDir = isRunningAsRoot() ? "/home/arisa/.claude" : join(process.env.HOME || "~", ".claude");
          try {
            if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
            const credsPath = join(claudeDir, ".credentials.json");
            const creds = {
              claudeAiOauth: {
                accessToken: token,
                expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
                scopes: ["user:inference", "user:profile"],
              },
            };
            writeFileSync(credsPath, JSON.stringify(creds, null, 2) + "\n");
            if (isRunningAsRoot()) {
              Bun.spawnSync(["chown", "-R", "arisa:arisa", claudeDir]);
            }
            console.log(`  ✓ credentials written to ${credsPath}`);
          } catch (e) {
            console.log(`  ⚠ could not write credentials file: ${e}`);
          }
        } else {
          console.log(`  ⚠ token extraction failed (indexOf=${startIdx}, len=${token.length})`);
          if (startIdx >= 0) {
            console.log(`  [clean] ${clean.substring(startIdx, startIdx + 150).replace(/\n/g, "\\n")}`);
          }
        }
        console.log(`  ✓ claude login successful`);
        return true;
      } else {
        console.log(`  ✗ claude login failed (exit ${exitCode})`);
        return false;
      }
    }

    // For codex and others: inherit all stdio
    const proc = Bun.spawn(buildBunWrappedAgentCliCommand(cli, args), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      console.log(`  ✓ ${cli} login successful`);
      return true;
    } else {
      console.log(`  ✗ ${cli} login failed (exit ${exitCode})`);
      return false;
    }
  } catch (e) {
    console.error(`  Login error: ${e}`);
    return false;
  }
}
