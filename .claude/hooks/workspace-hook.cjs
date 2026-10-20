'use strict';
/**
 * Delegates a project-level hook to the workspace harness.
 *
 * A session started *inside* a project directory loads that project's
 * .claude/settings.json, not the workspace root's — so the workspace guards would
 * otherwise be silently inactive exactly where the work happens. This shim walks up
 * to find the workspace harness and runs the real hook in-process, so stdin (the
 * hook payload) and the exit code both pass through untouched.
 *
 * Usage in settings.json:
 *   node "$CLAUDE_PROJECT_DIR/.claude/hooks/workspace-hook.cjs" guard-bash
 *
 * If no workspace is found above this project, the hook exits 0 — a project copied
 * out of the workspace keeps working, just without the shared guards.
 */

const fs = require('fs');
const path = require('path');

const MARKER = path.join('.claude', 'hooks', '_lib.cjs');
const hookName = process.argv[2];

if (!hookName) process.exit(0);

/** Nearest ancestor directory that contains the workspace harness. */
function findWorkspaceRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

try {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspace = findWorkspaceRoot(path.dirname(projectDir)) || findWorkspaceRoot(projectDir);
  if (!workspace) process.exit(0);

  const target = path.join(workspace, '.claude', 'hooks', `${hookName}.cjs`);
  if (!fs.existsSync(target)) process.exit(0);

  // The workspace hooks resolve config (skill-rules.json) relative to this.
  process.env.CLAUDE_PROJECT_DIR = workspace;
  require(target);
} catch (err) {
  if (process.env.HARNESS_DEBUG) {
    process.stderr.write(`[workspace-hook] ${err && err.stack ? err.stack : err}\n`);
  }
  process.exit(0); // never break a session over a missing workspace
}
