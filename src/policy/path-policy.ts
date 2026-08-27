import { realpath } from "node:fs/promises";
import path from "node:path";

const BLOCKED_SEGMENTS = new Set([
  ".agent-runs",
  ".agent-history",
  ".config",
  ".git",
  "node_modules",
]);
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /^\.(?:netrc|npmrc|pypirc)$/i,
  /^(?:credentials|secrets?)\.json$/i,
  /^(?:id_rsa|id_ed25519)$/i,
  /\.(?:pem|p12|pfx|key)$/i,
];

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Tool paths must be non-empty and relative to the workspace.");
  }

  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) {
    throw new Error(
      "Access to .agent-runs, .agent-history, .config, .git, and node_modules is blocked.",
    );
  }

  const basename = segments.at(-1) ?? "";
  if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
    throw new Error(`Access to sensitive file '${basename}' is blocked.`);
  }
}

export async function resolveExistingWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  assertSafeRelativePath(relativePath);
  const lexicalRoot = path.resolve(workspaceRoot);
  const lexicalCandidate = path.resolve(lexicalRoot, relativePath);
  if (!isInside(lexicalRoot, lexicalCandidate)) {
    throw new Error("Path escapes the workspace.");
  }

  const canonicalRoot = await realpath(lexicalRoot);
  const canonicalCandidate = await realpath(lexicalCandidate);
  if (!isInside(canonicalRoot, canonicalCandidate)) {
    throw new Error("Resolved path escapes the workspace through a symbolic link.");
  }
  // Keep the workspace's original path spelling after the canonical safety check.
  // On macOS, for example, /var resolves to /private/var; returning the canonical
  // candidate would make later workspace-relative paths incorrectly start with ../.
  return lexicalCandidate;
}

export async function resolveWorkspacePathForMutation(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  assertSafeRelativePath(relativePath);
  const lexicalRoot = path.resolve(workspaceRoot);
  const lexicalCandidate = path.resolve(lexicalRoot, relativePath);
  if (!isInside(lexicalRoot, lexicalCandidate) || lexicalCandidate === lexicalRoot) {
    throw new Error("Path escapes the workspace or points to the workspace root.");
  }

  const canonicalRoot = await realpath(lexicalRoot);
  const canonicalParent = await realpath(path.dirname(lexicalCandidate));
  if (!isInside(canonicalRoot, canonicalParent)) {
    throw new Error("Resolved parent path escapes the workspace through a symbolic link.");
  }
  return lexicalCandidate;
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/") || ".";
}
