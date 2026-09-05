import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { assertSafeRelativePath, isPathInside } from "../policy/path-policy.js";

export function assertPatchPath(value: string): void {
  if (!value || value !== value.trim() || value.endsWith("/") || value.includes("\\")
    || (process.platform !== "win32" && path.win32.isAbsolute(value) && !path.isAbsolute(value))) {
    throw new Error("Patch paths must use forward slashes and be relative or native absolute paths.");
  }
  if (/^[A-Za-z]:/.test(value) && !path.isAbsolute(value)) {
    throw new Error("Drive-relative patch paths are not supported; use an absolute path.");
  }
  assertSafeRelativePath(value.slice(path.parse(value).root.length) || ".");
}

/** Resolve parent aliases, leaving the final symlink intact so deletion removes only the link. */
export async function resolvePatchPath(workspaceRoot: string, value: string): Promise<string> {
  assertPatchPath(value);
  const candidate = path.resolve(workspaceRoot, value);
  const root = await realpath(workspaceRoot);
  let parent = path.dirname(candidate);
  const missing = [path.basename(candidate)];
  while (true) {
    try {
      await lstat(parent);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(path.basename(parent));
      const next = path.dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  // A dangling symlink is an error, not a missing directory to skip.
  const canonical = path.join(await realpath(parent), ...missing);
  if (canonical === root || canonical === path.parse(canonical).root) {
    throw new Error("A patch cannot target the workspace or filesystem root.");
  }
  const checkedPath = isPathInside(root, canonical) ? path.relative(root, canonical) : canonical;
  assertPatchPath(checkedPath.split(path.sep).join("/"));
  return canonical;
}
