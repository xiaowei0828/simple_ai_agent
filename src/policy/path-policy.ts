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

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Tool paths must be non-empty and relative to the workspace.");
  }

  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error(
      "Access to .agent-runs, .agent-history, .config, .git, and node_modules is blocked.",
    );
  }

  const sensitiveSegment = segments.find((segment) => (
    SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(segment))
  ));
  if (sensitiveSegment) {
    throw new Error(`Access to sensitive path segment '${sensitiveSegment}' is blocked.`);
  }

  if (process.platform === "win32") {
    const windowsDevice = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/i;
    const unsafeSegment = segments.find((segment) => (
      segment !== "." && segment !== ".." && (
        segment.includes(":") || /[. ]$/u.test(segment) || windowsDevice.test(segment)
      )
    ));
    if (unsafeSegment) {
      throw new Error(`Windows path segment '${unsafeSegment}' is not allowed.`);
    }
  }
}

export async function resolveExistingWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  const lexicalRoot = path.resolve(workspaceRoot);
  const canonicalRoot = await realpath(lexicalRoot);
  assertSafeRelativePath(relativePath);
  const lexicalCandidate = path.resolve(lexicalRoot, relativePath);
  if (!isPathInside(lexicalRoot, lexicalCandidate)) {
    throw new Error("Path escapes the workspace.");
  }
  const canonicalCandidate = await realpath(lexicalCandidate);
  if (!isPathInside(canonicalRoot, canonicalCandidate)) {
    throw new Error("Resolved path escapes the workspace through a symbolic link.");
  }
  assertSafeRelativePath(path.relative(canonicalRoot, canonicalCandidate) || ".");
  // Preserve the caller's path spelling after canonical safety checks (e.g. /var on macOS).
  return lexicalCandidate;
}
