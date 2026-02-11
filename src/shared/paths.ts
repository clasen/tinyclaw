/**
 * @module shared/paths
 * @role Resolve project and runtime data directories with migration-safe defaults.
 * @responsibilities
 *   - Resolve project directory (supports ARISA_PROJECT_DIR override)
 *   - Resolve runtime data directory (prefers ~/.arisa by default)
 *   - Migrate legacy project-local dirs (.tinyclaw/.arisa) into ~/.arisa
 *   - Support ARISA_DATA_DIR override for advanced deployments
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

const DEFAULT_PROJECT_DIR = join(import.meta.dir, "..", "..");
const PROJECT_DIR = process.env.ARISA_PROJECT_DIR
  ? resolve(process.env.ARISA_PROJECT_DIR)
  : DEFAULT_PROJECT_DIR;

const HOME_DATA_DIR = join(homedir(), ".arisa");
const PROJECT_ARISA_DIR = join(PROJECT_DIR, ".arisa");
const LEGACY_DATA_DIR = join(PROJECT_DIR, ".tinyclaw");

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function hasFiles(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function moveOrMerge(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir) || samePath(sourceDir, targetDir)) return;

  try {
    if (!existsSync(targetDir)) {
      mkdirSync(resolve(targetDir, ".."), { recursive: true });
      renameSync(sourceDir, targetDir);
      return;
    }

    // Merge source into target and drop source afterward.
    cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: false });
    rmSync(sourceDir, { recursive: true, force: true });
  } catch {
    // Do not crash startup if migration has a filesystem issue.
  }
}

function resolveOverrideDataDir(): string | null {
  const override = process.env.ARISA_DATA_DIR?.trim();
  if (!override) return null;
  return isAbsolute(override) ? override : resolve(PROJECT_DIR, override);
}

function resolveDataDir(): string {
  const overrideDir = resolveOverrideDataDir();
  if (overrideDir) {
    return overrideDir;
  }

  // One-time migration from local runtime dirs to ~/.arisa.
  if (!hasFiles(HOME_DATA_DIR)) {
    if (hasFiles(PROJECT_ARISA_DIR)) {
      moveOrMerge(PROJECT_ARISA_DIR, HOME_DATA_DIR);
    } else if (hasFiles(LEGACY_DATA_DIR)) {
      moveOrMerge(LEGACY_DATA_DIR, HOME_DATA_DIR);
    }
  } else {
    // If ~/.arisa already exists, still merge any local leftovers into it.
    if (hasFiles(PROJECT_ARISA_DIR)) moveOrMerge(PROJECT_ARISA_DIR, HOME_DATA_DIR);
    if (hasFiles(LEGACY_DATA_DIR)) moveOrMerge(LEGACY_DATA_DIR, HOME_DATA_DIR);
  }

  if (!existsSync(HOME_DATA_DIR)) {
    mkdirSync(HOME_DATA_DIR, { recursive: true });
  }

  return HOME_DATA_DIR;
}

export const projectDir = PROJECT_DIR;
export const preferredDataDir = HOME_DATA_DIR;
export const projectLocalDataDir = PROJECT_ARISA_DIR;
export const legacyDataDir = LEGACY_DATA_DIR;
export const dataDir = resolveDataDir();
