import { opendir } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".agent-runs", ".agent-history", ".config", "node_modules",
  "dist", "build", ".next", ".turbo", "coverage",
]);

export interface WalkFilesOptions {
  maxFiles: number;
  maxDirectories: number;
  maxEntries: number;
  includeFile: (absolutePath: string) => boolean;
}

/** Bounded discovery for the startup documentation catalog; skips symlinks. */
export async function walkFiles(root: string, options: WalkFilesOptions): Promise<string[]> {
  const files: string[] = [];
  const pendingDirectories = [root];
  let entriesScanned = 0;

  for (let index = 0; index < pendingDirectories.length && index < options.maxDirectories; index += 1) {
    const directory = pendingDirectories[index]!;
    const entries: import("node:fs").Dirent[] = [];
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (entriesScanned >= options.maxEntries) break;
        entriesScanned += 1;
        entries.push(entry);
      }
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      if (name.startsWith(".env") || name === ".ds_store") continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(name)) pendingDirectories.push(absolutePath);
      } else if (entry.isFile() && options.includeFile(absolutePath)) {
        files.push(absolutePath);
        if (files.length >= options.maxFiles) return files;
      }
    }
    if (entriesScanned >= options.maxEntries) break;
  }
  return files;
}
