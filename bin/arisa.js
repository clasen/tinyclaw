#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const pkgRoot = resolve(__dirname, "..");
const args = process.argv.slice(2);
const command = (args[0] || "start").toLowerCase();
const rest = args.slice(1);

function printHelp() {
  process.stdout.write(
    `Arisa CLI

Usage:
  arisa                 Start daemon (default)
  arisa start           Start daemon
  arisa daemon          Start daemon
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

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "version" || command === "--version" || command === "-v") {
  printVersion();
  process.exit(0);
}

const env = {
  ...process.env,
};

let bunArgs;
switch (command) {
  case "start":
  case "daemon":
    bunArgs = [join(pkgRoot, "src", "daemon", "index.ts"), ...rest];
    break;
  case "core":
    bunArgs = [join(pkgRoot, "src", "core", "index.ts"), ...rest];
    break;
  case "dev":
    bunArgs = ["--watch", join(pkgRoot, "src", "core", "index.ts"), ...rest];
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printHelp();
    process.exit(1);
}

const bunExecutable = process.env.BUN_BIN || "bun";
const child = spawnSync(bunExecutable, bunArgs, {
  stdio: "inherit",
  cwd: process.cwd(),
  env,
  shell: process.platform === "win32",
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

process.exit(child.status === null ? 1 : child.status);
