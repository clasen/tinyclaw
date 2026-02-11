#!/usr/bin/env node

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
const { join, resolve } = require("node:path");

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

function printForegroundNotice() {
  process.stdout.write("Starting Arisa in foreground. Press Ctrl+C to stop.\n");
  process.stdout.write("Use `arisa start` to run it as a background service.\n");
}

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
    if (isDefaultInvocation) {
      printForegroundNotice();
    }
    const child = runWithBun([daemonEntry, ...rest]);
    process.exit(child.status === null ? 1 : child.status);
  }
  case "core":
    {
      const child = runWithBun([coreEntry, ...rest]);
      process.exit(child.status === null ? 1 : child.status);
    }
  case "dev":
    {
      const child = runWithBun(["--watch", coreEntry, ...rest]);
      process.exit(child.status === null ? 1 : child.status);
    }
  default:
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printHelp();
    process.exit(1);
}
