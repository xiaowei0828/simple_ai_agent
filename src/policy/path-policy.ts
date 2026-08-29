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

export interface WorkspacePathResolver {
  resolveExisting(relativePath: string): Promise<string>;
  resolveForMutation(relativePath: string): Promise<string>;
}

export async function createWorkspacePathResolver(
  workspaceRoot: string,
): Promise<WorkspacePathResolver> {
  const lexicalRoot = path.resolve(workspaceRoot);
  const canonicalRoot = await realpath(lexicalRoot);

  return {
    async resolveExisting(relativePath: string): Promise<string> {
      assertSafeRelativePath(relativePath);
      const lexicalCandidate = path.resolve(lexicalRoot, relativePath);
      if (!isInside(lexicalRoot, lexicalCandidate)) {
        throw new Error("Path escapes the workspace.");
      }

      const canonicalCandidate = await realpath(lexicalCandidate);
      if (!isInside(canonicalRoot, canonicalCandidate)) {
        throw new Error("Resolved path escapes the workspace through a symbolic link.");
      }
      assertSafeRelativePath(path.relative(canonicalRoot, canonicalCandidate) || ".");
      return lexicalCandidate;
    },

    async resolveForMutation(relativePath: string): Promise<string> {
      assertSafeRelativePath(relativePath);
      const lexicalCandidate = path.resolve(lexicalRoot, relativePath);
      if (!isInside(lexicalRoot, lexicalCandidate) || lexicalCandidate === lexicalRoot) {
        throw new Error("Path escapes the workspace or points to the workspace root.");
      }

      const canonicalParent = await realpath(path.dirname(lexicalCandidate));
      if (!isInside(canonicalRoot, canonicalParent)) {
        throw new Error("Resolved parent path escapes the workspace through a symbolic link.");
      }
      assertSafeRelativePath(path.relative(canonicalRoot, canonicalParent) || ".");
      return lexicalCandidate;
    },
  };
}

export async function resolveExistingWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  const resolver = await createWorkspacePathResolver(workspaceRoot);
  const lexicalCandidate = await resolver.resolveExisting(relativePath);
  // Keep the workspace's original path spelling after the canonical safety check.
  // On macOS, for example, /var resolves to /private/var; returning the canonical
  // candidate would make later workspace-relative paths incorrectly start with ../.
  return lexicalCandidate;
}

export async function resolveWorkspacePathForMutation(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  const resolver = await createWorkspacePathResolver(workspaceRoot);
  return resolver.resolveForMutation(relativePath);
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/") || ".";
}
