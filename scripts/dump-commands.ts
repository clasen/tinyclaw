#!/usr/bin/env bun
/**
 * Diagnostic: prints the exact su/bun commands that Arisa would execute,
 * ready to copy-paste into a terminal.
 */
import { buildBunWrappedAgentCliCommand } from "../src/shared/ai-cli";

function printable(cmd: string[]): string {
  if (cmd[0] === "su") {
    // cmd = ["su", "arisa", "-s", "/bin/bash", "-c", "<bash script>"]
    // Wrap the -c argument in double quotes — safe because shellEscape only uses single quotes
    return `${cmd.slice(0, 5).join(" ")} "${cmd[5]}"`;
  }
  // Non-root: just join, quoting args with spaces
  return cmd.map(c => /[\s']/.test(c) ? `"${c}"` : c).join(" ");
}

const probeArgs = ["-p", "say ok", "--model", "haiku", "--output-format", "text", "--dangerously-skip-permissions"];
const processorArgs = ["--dangerously-skip-permissions", "--output-format", "text", "--model", "claude-sonnet-4-20250514", "-p", "hello test"];

console.log("=== AUTH PROBE (daemon/auto-install.ts) ===\n");
console.log(printable(buildBunWrappedAgentCliCommand("claude", probeArgs)));

console.log("\n\n=== MESSAGE PROCESSOR (core/processor.ts) ===\n");
console.log(printable(buildBunWrappedAgentCliCommand("claude", processorArgs)));
console.log();
