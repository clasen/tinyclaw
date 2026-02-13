/**
 * @module shared/ports
 * @role Process cleanup via PID files + /proc scan, retry-aware Bun.serve.
 * @effects Reads/writes runtime pid files, kills processes via SIGKILL
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { dataDir } from "./paths";

const ARISA_DIR = dataDir;

function pidPath(name: string): string {
  return join(ARISA_DIR, `${name}.pid`);
}

// Patterns to match in /proc cmdline for each process type
const CMDLINE_PATTERNS: Record<string, string> = {
  daemon: "daemon/index.ts",
  core: "core/index.ts",
};

/**
 * Kill previous instances of a named process, then write our PID.
 * Uses PID file + /proc scan for robustness in containers.
 */
export function claimProcess(name: string): void {
  const myPid = process.pid;

  // 1. Kill from PID file
  const path = pidPath(name);
  if (existsSync(path)) {
    try {
      const oldPid = parseInt(readFileSync(path, "utf8").trim(), 10);
      if (oldPid && oldPid !== myPid) {
        try { process.kill(oldPid, "SIGKILL"); } catch {}
      }
    } catch {}
  }

  // 2. Scan /proc for any matching processes (Linux containers)
  const pattern = CMDLINE_PATTERNS[name];
  if (pattern) {
    killByPattern(pattern, myPid);
  }

  // 3. Write our PID
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(myPid));

  // 4. Brief pause to let OS release resources
  Bun.sleepSync(200);
}

// Scan /proc cmdline and kill processes matching a pattern (Linux only).
function killByPattern(pattern: string, excludePid: number): void {
  try {
    if (!existsSync("/proc")) return;
    const dirs = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    for (const pid of dirs) {
      const numPid = Number(pid);
      if (numPid === excludePid) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (cmdline.includes(pattern)) {
          process.kill(numPid, "SIGKILL");
        }
      } catch {}
    }
  } catch {}
}

/**
 * Remove our PID file on clean shutdown.
 */
export function releaseProcess(name: string): void {
  try { unlinkSync(pidPath(name)); } catch {}
}

/**
 * Remove a Unix socket file if it exists (stale leftover from crash).
 */
export function cleanupSocket(socketPath: string): void {
  try { unlinkSync(socketPath); } catch {}
}

/**
 * Bun.serve() with retry — handles both TCP ports and Unix sockets.
 * For Unix sockets, cleans up stale socket file before first attempt.
 */
export async function serveWithRetry(
  options: Parameters<typeof Bun.serve>[0],
  retries = 5,
): Promise<ReturnType<typeof Bun.serve>> {
  const socketPath = (options as any).unix as string | undefined;

  // Pre-clean stale Unix socket from a previous crash
  if (socketPath) cleanupSocket(socketPath);

  for (let i = 0; i < retries; i++) {
    try {
      const server = Bun.serve(options);
      // Make Unix sockets world-accessible so Core (arisa) and Daemon (root)
      // can connect to each other's sockets regardless of ownership.
      if (socketPath) try { chmodSync(socketPath, 0o777); } catch {}
      return server;
    } catch (e: any) {
      if (e?.code !== "EADDRINUSE" || i === retries - 1) throw e;
      if (socketPath) {
        console.log(`[ports] Socket ${socketPath} busy, cleaning up and retrying (${i + 1}/${retries})...`);
        cleanupSocket(socketPath);
      } else {
        const port = (options as any).port ?? "?";
        console.log(`[ports] Port ${port} busy, retrying (${i + 1}/${retries})...`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("unreachable");
}
