#!/usr/bin/env bun

const { spawn, spawnSync } = require("node:child_process");
const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { homedir, platform } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const pkgRoot = resolve(__dirname, "..");
const daemonEntry = join(pkgRoot, "src", "daemon", "index.ts");
const coreEntry = join(pkgRoot, "src", "core", "index.ts");
const homeDir = homedir();
const arisaDir = join(homeDir, ".arisa");
const runDir = join(arisaDir, "run");
const logsDir = join(arisaDir, "logs");
const pidFile = join(runDir, "arisa.pid");
const fallbackLogFile = join(logsDir, "service.log");
const systemdServiceName = "arisa.service";
const systemdUserDir = join(homeDir, ".config", "systemd", "user");
const systemdUserUnitPath = join(systemdUserDir, systemdServiceName);

const args = process.argv.slice(2);
const inputCommand = (args[0] || "").toLowerCase();
const command = inputCommand || "daemon";
const rest = inputCommand ? args.slice(1) : args;
const isDefaultInvocation = inputCommand === "";

function printHelp() {
  process.stdout.write(
    `Arisa CLI

Usage:
  arisa                 Start daemon in foreground (default)
  arisa start           Start service and enable restart-on-boot
  arisa stop            Stop service
  arisa status          Show service status
  arisa restart         Restart service
  arisa daemon          Start daemon in foreground
  arisa run             Start daemon in foreground
  arisa start --foreground
                        Start daemon in foreground (legacy behavior)
  arisa core            Start core only
  arisa dev             Start core in watch mode
  arisa version         Print version
  arisa help            Show this help
`
  );
}

function printVersion() {
  const pkgPath = join(pkgRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  process.stdout.write(`${pkg.version}\n`);
}

function commandExists(binary) {
  const probe = spawnSync("sh", ["-lc", `command -v ${binary} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function runCommand(executable, commandArgs, options = {}) {
  return spawnSync(executable, commandArgs, {
    encoding: "utf8",
    ...options,
  });
}

function resolveBunExecutable() {
  if (process.env.BUN_BIN && process.env.BUN_BIN.trim()) {
    return process.env.BUN_BIN.trim();
  }

  const bunInstall = process.env.BUN_INSTALL || join(homeDir, ".bun");
  const bunFromInstall = join(bunInstall, "bin", "bun");
  if (existsSync(bunFromInstall)) {
    return bunFromInstall;
  }

  return "bun";
}

function runWithBun(bunArgs, options = {}) {
  const bunExecutable = resolveBunExecutable();
  const child = runCommand(bunExecutable, bunArgs, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: {
      ...process.env,
      ARISA_PROJECT_DIR: process.env.ARISA_PROJECT_DIR || pkgRoot,
    },
    shell: process.platform === "win32",
    ...options,
  });

  if (child.error) {
    if (child.error.code === "ENOENT") {
      process.stderr.write(
        "Arisa requires Bun to run. Install it from https://bun.sh/ and retry.\n"
      );
      process.exit(1);
    }
    process.stderr.write(`${String(child.error)}\n`);
    process.exit(1);
  }

  return child;
}

function ensureRuntimeDirs() {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
}

function readPid() {
  if (!existsSync(pidFile)) return null;

  try {
    const raw = readFileSync(pidFile, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function removePidFile() {
  if (!existsSync(pidFile)) return;
  try {
    unlinkSync(pidFile);
  } catch {
    // Best effort cleanup.
  }
}

function cleanupStalePidFile() {
  const pid = readPid();
  if (!pid) {
    removePidFile();
    return null;
  }

  if (!isPidRunning(pid)) {
    removePidFile();
    return null;
  }

  return pid;
}

function startDetachedFallback() {
  ensureRuntimeDirs();
  const runningPid = cleanupStalePidFile();
  if (runningPid) {
    process.stdout.write(
      `Arisa is already running in fallback mode (PID ${runningPid}).\n`
    );
    return 0;
  }

  const bunExecutable = resolveBunExecutable();
  const logFd = openSync(fallbackLogFile, "a");
  const child = spawn(bunExecutable, [daemonEntry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: pkgRoot,
    env: {
      ...process.env,
      ARISA_PROJECT_DIR: process.env.ARISA_PROJECT_DIR || pkgRoot,
    },
    shell: process.platform === "win32",
  });

  closeSync(logFd);
  if (!child.pid) {
    process.stderr.write(
      "Failed to start Arisa in fallback mode. Ensure Bun is installed and in PATH.\n"
    );
    return 1;
  }

  child.unref();

  writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  process.stdout.write(
    `Arisa started in fallback mode (PID ${child.pid}). Logs: ${fallbackLogFile}\n`
  );
  process.stdout.write(
    "Autostart on reboot requires systemd user services.\n"
  );
  return 0;
}

function stopDetachedFallback() {
  const runningPid = cleanupStalePidFile();
  if (!runningPid) {
    process.stdout.write("Arisa is not running (fallback mode).\n");
    return 0;
  }

  try {
    process.kill(runningPid, "SIGTERM");
    removePidFile();
    process.stdout.write(`Sent SIGTERM to Arisa (PID ${runningPid}).\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `Failed to stop Arisa PID ${runningPid}: ${error.message}\n`
    );
    return 1;
  }
}

function statusDetachedFallback() {
  const runningPid = cleanupStalePidFile();
  if (!runningPid) {
    process.stdout.write("Arisa is not running (fallback mode).\n");
    return 1;
  }

  process.stdout.write(`Arisa is running in fallback mode (PID ${runningPid}).\n`);
  process.stdout.write(`Logs: ${fallbackLogFile}\n`);
  return 0;
}

function canUseSystemdUser() {
  if (platform() !== "linux") return false;
  if (!commandExists("systemctl")) return false;

  const probe = runCommand("systemctl", ["--user", "show-environment"], {
    stdio: "pipe",
  });

  return probe.status === 0;
}

function writeSystemdUserUnit() {
  mkdirSync(systemdUserDir, { recursive: true });

  const bunInstall = process.env.BUN_INSTALL || join(homeDir, ".bun");
  const pathValue = process.env.PATH || `${join(bunInstall, "bin")}:/usr/local/bin:/usr/bin:/bin`;
  const bunExecutable = resolveBunExecutable();

  const unit = `[Unit]
Description=Arisa Daemon Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${pkgRoot}
ExecStart=${bunExecutable} ${daemonEntry}
Restart=always
RestartSec=3
Environment=ARISA_PROJECT_DIR=${pkgRoot}
Environment=BUN_INSTALL=${bunInstall}
Environment=PATH=${pathValue}

[Install]
WantedBy=default.target
`;

  writeFileSync(systemdUserUnitPath, unit, "utf8");
}

function runSystemd(commandArgs) {
  const child = runCommand("systemctl", ["--user", ...commandArgs], {
    stdio: "pipe",
  });

  if (child.status !== 0) {
    const stderr = child.stderr || "Unknown systemd error";
    process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
    return { ok: false, status: child.status ?? 1 };
  }

  return { ok: true, status: 0, stdout: child.stdout || "" };
}

function startSystemdService() {
  writeSystemdUserUnit();

  const reload = runSystemd(["daemon-reload"]);
  if (!reload.ok) return reload.status;

  const start = runSystemd(["enable", "--now", systemdServiceName]);
  if (!start.ok) return start.status;

  process.stdout.write(
    "Arisa service started and enabled (systemd --user).\n"
  );
  process.stdout.write(
    "To keep it running after reboot without login, run: sudo loginctl enable-linger $USER\n"
  );
  return 0;
}

function stopSystemdService() {
  const stop = runSystemd(["stop", systemdServiceName]);
  if (!stop.ok) return stop.status;

  process.stdout.write("Arisa service stopped (systemd --user).\n");
  return 0;
}

function restartSystemdService() {
  const restart = runSystemd(["restart", systemdServiceName]);
  if (!restart.ok) return restart.status;

  process.stdout.write("Arisa service restarted (systemd --user).\n");
  return 0;
}

function statusSystemdService() {
  const activeResult = runCommand(
    "systemctl",
    ["--user", "is-active", systemdServiceName],
    { stdio: "pipe" }
  );
  const enabledResult = runCommand(
    "systemctl",
    ["--user", "is-enabled", systemdServiceName],
    { stdio: "pipe" }
  );

  const active = activeResult.status === 0;
  const enabled = enabledResult.status === 0;

  if (active) {
    process.stdout.write("Arisa service status: active (systemd --user).\n");
  } else {
    process.stdout.write("Arisa service status: inactive (systemd --user).\n");
  }

  if (enabled) {
    process.stdout.write("Autostart: enabled\n");
    return active ? 0 : 1;
  }

  process.stdout.write("Autostart: disabled\n");
  return active ? 0 : 1;
}

function restartDetachedFallback() {
  const stopCode = stopDetachedFallback();
  if (stopCode !== 0) return stopCode;
  return startDetachedFallback();
}

function startService() {
  if (rest.includes("--foreground")) {
    const foregroundArgs = rest.filter((arg) => arg !== "--foreground");
    const child = runWithBun([daemonEntry, ...foregroundArgs]);
    return child.status === null ? 1 : child.status;
  }

  if (canUseSystemdUser()) {
    return startSystemdService();
  }
  return startDetachedFallback();
}

function stopService() {
  if (canUseSystemdUser()) {
    return stopSystemdService();
  }
  return stopDetachedFallback();
}

function statusService() {
  if (canUseSystemdUser()) {
    return statusSystemdService();
  }
  return statusDetachedFallback();
}

function restartService() {
  if (canUseSystemdUser()) {
    return restartSystemdService();
  }
  return restartDetachedFallback();
}


// ── Root: create arisa user for Core process execution ──────────────
// Daemon runs as root. Core runs as user arisa (Claude CLI refuses root).
// This means Claude/Codex calls from Core are direct — no su wrapping.

function isRoot() {
  return process.getuid?.() === 0;
}

function arisaUserExists() {
  return spawnSync("id", ["arisa"], { stdio: "ignore" }).status === 0;
}

function isArisaUserProvisioned() {
  return arisaUserExists();
}

function step(ok, msg) {
  process.stdout.write(`  ${ok ? "\u2713" : "\u2717"} ${msg}\n`);
}

const ROOT_BUN_INSTALL = process.env.BUN_INSTALL || join(homeDir, ".bun");
const ARISA_BUN_ENV = `export BUN_INSTALL=${ROOT_BUN_INSTALL} && export PATH=${ROOT_BUN_INSTALL}/bin:$PATH`;

function provisionArisaUser() {
  process.stdout.write("Creating user 'arisa' for Claude/Codex CLI execution...\n");

  // 1. Create user with sudo access
  const useradd = spawnSync("useradd", ["-m", "-s", "/bin/bash", "arisa"], { stdio: "pipe" });
  if (useradd.status !== 0) {
    step(false, `Failed to create user: ${(useradd.stderr || "").toString().trim()}`);
    process.exit(1);
  }
  step(true, "User arisa created");

  // 2. Grant passwordless sudo (needed for full tool execution in Claude/Codex)
  try {
    writeFileSync("/etc/sudoers.d/arisa", "arisa ALL=(ALL) NOPASSWD: ALL\n", { mode: 0o440 });
    step(true, "Passwordless sudo granted");
  } catch (e) {
    // Not fatal — sudo may not be installed in minimal containers
    step(false, `Sudo setup skipped: ${e.message || e}`);
  }

  // 3. Give arisa access to root's bun (no separate install needed)
  grantBunAccess();
  step(true, "Access to root's bun granted");

  process.stdout.write("  Done. Core will run as arisa; Claude/Codex calls are direct.\n\n");
}

function grantBunAccess() {
  // Allow arisa to traverse into /root (execute only, not read)
  spawnSync("chmod", ["o+x", homeDir], { stdio: "ignore" });
  // Allow arisa to read+execute root's bun and globally installed CLIs
  spawnSync("chmod", ["-R", "o+rX", ROOT_BUN_INSTALL], { stdio: "ignore" });
}

// Provision arisa user if running as root and not yet done
if (isRoot() && !isArisaUserProvisioned()) {
  provisionArisaUser();
}

// When root + arisa exists: route all runtime data through arisa's home
// so Core (running as arisa) and Daemon (root) share the same data dir.
if (isRoot() && arisaUserExists()) {
  // Ensure arisa can access root's bun on every startup
  grantBunAccess();
  const arisaDataDir = "/home/arisa/.arisa";
  const rootDataDir = join("/root", ".arisa");

  // One-time migration from root's data dir
  if (existsSync(rootDataDir) && !existsSync(arisaDataDir)) {
    spawnSync("cp", ["-r", rootDataDir, arisaDataDir], { stdio: "ignore" });
    spawnSync("chown", ["-R", "arisa:arisa", arisaDataDir], { stdio: "ignore" });
  }

  // Ensure arisa data dir exists with correct ownership
  if (!existsSync(arisaDataDir)) {
    mkdirSync(arisaDataDir, { recursive: true });
    spawnSync("chown", ["-R", "arisa:arisa", arisaDataDir], { stdio: "ignore" });
  }

  // Ensure arisa can traverse to and read project files.
  // When installed globally under /root/.bun/..., parent dirs are mode 700.
  // Add o+x (traverse only, not read) on each ancestor so arisa can reach pkgRoot.
  let traverseDir = pkgRoot;
  while (traverseDir !== "/") {
    spawnSync("chmod", ["o+x", traverseDir], { stdio: "ignore" });
    traverseDir = dirname(traverseDir);
  }
  spawnSync("chmod", ["-R", "o+rX", pkgRoot], { stdio: "ignore" });

  // All processes use arisa's data dir (inherited by Daemon → Core)
  process.env.ARISA_DATA_DIR = arisaDataDir;

  // Permissive umask so files Daemon (root) creates at runtime in the shared
  // data dir are readable/writable by Core (arisa). Safe in Docker containers.
  process.umask(0o000);
}

// Pre-flight: install missing CLIs while still root (before su arisa).
// arisa user has read+execute but NOT write access to root's bun dir.
// Uses @inquirer/prompts checkbox when available (same UI as setup.ts).
async function preflightInstallClis() {
  const clis = {
    claude: "@anthropic-ai/claude-code",
    codex: "@openai/codex",
  };

  const bunBinDir = join(ROOT_BUN_INSTALL, "bin");
  const missing = [];

  for (const [name, pkg] of Object.entries(clis)) {
    if (existsSync(join(bunBinDir, name))) continue;
    missing.push({ name, pkg });
  }

  if (missing.length === 0) return;

  // Show status
  process.stdout.write("\nCLI Status:\n");
  for (const name of Object.keys(clis)) {
    const installed = existsSync(join(bunBinDir, name));
    const label = name === "claude" ? "Claude" : "Codex";
    process.stdout.write(`  ${installed ? "\u2713" : "\u2717"} ${label}${installed ? "" : " \u2014 not installed"}\n`);
  }

  let toInstall = missing;

  if (process.stdin.isTTY) {
    // Try @inquirer/prompts for the same checkbox UI as setup.ts
    let inq = null;
    try { inq = await import("@inquirer/prompts"); } catch {}

    if (inq) {
      const selected = await inq.checkbox({
        message: "Install missing CLIs? (space to select, enter to confirm)",
        choices: missing.map((cli) => ({
          name: `${cli.name === "claude" ? "Claude" : "Codex"} (${cli.pkg})`,
          value: cli,
          checked: true,
        })),
      });
      toInstall = selected;
    } else {
      // Fallback: simple Y/n
      const rl = require("node:readline");
      const ask = (q) =>
        new Promise((resolve) => {
          const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
          iface.question(q, (a) => { iface.close(); resolve(a.trim()); });
        });
      const answer = await ask("\nInstall missing CLIs? (Y/n): ");
      if (answer.toLowerCase() === "n") toInstall = [];
    }
  }

  if (toInstall.length === 0) {
    process.stdout.write("  Skipping CLI installation.\n");
    return;
  }

  for (const { name, pkg } of toInstall) {
    process.stdout.write(`\nInstalling ${name}...\n`);
    const result = spawnSync("bun", ["add", "-g", pkg], {
      stdio: "inherit",
      timeout: 180000,
    });
    if (result.status === 0) {
      process.stdout.write(`  \u2713 ${name} installed\n`);
    } else {
      process.stdout.write(`  \u2717 ${name} install failed\n`);
    }
  }

  // Re-grant read+execute access after installing new binaries
  grantBunAccess();
}

if (isRoot() && arisaUserExists()) {
  await preflightInstallClis();
}

// Then fall through to normal daemon startup

// ── Non-root flow (unchanged) ───────────────────────────────────────

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "version" || command === "--version" || command === "-v") {
  printVersion();
  process.exit(0);
}

switch (command) {
  case "start":
    process.exit(startService());
    break;
  case "stop":
    process.exit(stopService());
    break;
  case "status":
    process.exit(statusService());
    break;
  case "restart":
    process.exit(restartService());
    break;
  case "daemon":
  case "run": {
    // Single bun process: daemon + core in-process with --watch.
    // When root, run as arisa (Claude CLI refuses root). su without "-"
    // preserves parent env (ARISA_DATA_DIR, tokens, API keys).
    let child;
    if (isRoot() && arisaUserExists()) {
      const bunEnv = `export HOME=/home/arisa && ${ARISA_BUN_ENV}`;
      const cmd = `${bunEnv} && cd ${pkgRoot} && exec bun --watch ${daemonEntry}`;
      child = spawnSync("su", ["arisa", "-s", "/bin/bash", "-c", cmd], {
        stdio: "inherit",
        env: process.env,
      });
    } else {
      child = runWithBun(["--watch", daemonEntry, ...rest]);
    }
    process.exit(child.status === null ? 1 : child.status);
  }
  case "core": {
    await import(coreEntry);
    break;
  }
  case "dev":
    {
      // dev needs --watch which is a bun CLI flag, so child process required
      const child = runWithBun(["--watch", coreEntry, ...rest]);
      process.exit(child.status === null ? 1 : child.status);
    }
  default:
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printHelp();
    process.exit(1);
}
