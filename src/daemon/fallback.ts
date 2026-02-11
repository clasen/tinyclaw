/**
 * @module daemon/fallback
 * @role Direct AI CLI invocation when Core is down.
 * @responsibilities
 *   - Call claude/codex CLI directly as emergency fallback
 *   - Include Core error context so the model can help diagnose
 * @dependencies shared/config
 * @effects Spawns AI CLI process
 * @contract fallbackClaude(message, coreError?) => Promise<string>
 */

import { config } from "../shared/config";
import { createLogger } from "../shared/logger";
import { getAgentCliLabel, runWithCliFallback } from "./agent-cli";

const log = createLogger("daemon");

export async function fallbackClaude(message: string, coreError?: string): Promise<string> {
  const systemContext = coreError
    ? `[System: Core process is down. Error: ${coreError}. You are running in fallback mode from Daemon. The user's project is at ${config.projectDir}. Respond to the user normally. If they ask about the error, explain what you see.]\n\n`
    : `[System: Core process is down. You are running in fallback mode from Daemon. The user's project is at ${config.projectDir}. Respond to the user normally.]\n\n`;

  const prompt = systemContext + message;

  try {
    const outcome = await runWithCliFallback(prompt, config.claudeTimeout);
    const result = outcome.result;

    if (!result) {
      if (outcome.attempted.length === 0) {
        return "[Fallback mode] Neither Claude nor Codex CLI is available. Core is down and fallback is unavailable.";
      }
      log.error(`Fallback failed: ${outcome.failures.join(" | ").slice(0, 500)}`);
      return "[Fallback mode] Claude and Codex fallback both failed. Core is down and fallback is unavailable. Please check server logs.";
    }

    const cli = getAgentCliLabel(result.cli);
    if (result.partial) {
      log.warn(`Fallback ${cli} returned output but exited with code ${result.exitCode}`);
    } else {
      log.warn(`Using fallback ${cli} CLI`);
    }

    return result.output || `[Fallback mode] Empty response from ${cli} CLI.`;
  } catch (error) {
    log.error(`Fallback CLI error: ${error}`);
    return "[Fallback mode] Could not reach fallback CLI. Core is down and fallback is unavailable. Please check server logs.";
  }
}
