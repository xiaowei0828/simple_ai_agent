import { opendir } from "node:fs/promises";
import path from "node:path";

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".agent-runs",
  ".agent-history",
  ".config",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

export interface WalkFilesResult {
  files: string[];
  directoriesScanned: number;
  entriesScanned: number;
  unreadableDirectories: number;
  ignoredPaths: number;
  filteredFiles: number;
  limitReached: WalkLimitName | null;
  truncated: boolean;
}

export type WalkLimitName = "file_limit" | "directory_limit" | "entry_limit";

export interface WalkFilesOptions {
  maxFiles: number;
  maxDirectories: number;
  maxEntries: number;
  includeFile?: (absolutePath: string) => boolean;
}

export async function walkFiles(root: string, maxResults: number): Promise<string[]> {
  return (await walkFilesWithMetadata(root, defaultWalkOptions(maxResults))).files;
}

export async function walkFilesWithMetadata(
  root: string,
  options: WalkFilesOptions,
): Promise<WalkFilesResult> {
  const files: string[] = [];
  let directoriesScanned = 0;
  let entriesScanned = 0;
  let unreadableDirectories = 0;
  let ignoredPaths = 0;
  let filteredFiles = 0;
  let limitReached: WalkLimitName | null = null;
  const pendingDirectories = [root];

  for (let directoryIndex = 0; directoryIndex < pendingDirectories.length; directoryIndex += 1) {
    if (directoriesScanned >= options.maxDirectories) {
      limitReached = "directory_limit";
      break;
    }
    const directory = pendingDirectories[directoryIndex];
    if (!directory) continue;
    directoriesScanned += 1;

    const entries: import("node:fs").Dirent[] = [];
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (entriesScanned >= options.maxEntries) {
          limitReached = "entry_limit";
          break;
        }
        entriesScanned += 1;
        entries.push(entry);
      }
    } catch {
      unreadableDirectories += 1;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const normalizedName = entry.name.toLowerCase();
      if (normalizedName.startsWith(".env") || normalizedName === ".ds_store") {
        ignoredPaths += 1;
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(normalizedName)) {
          ignoredPaths += 1;
          continue;
        }
        pendingDirectories.push(absolutePath);
      } else if (entry.isFile()) {
        if (options.includeFile && !options.includeFile(absolutePath)) {
          filteredFiles += 1;
          continue;
        }
        if (files.length >= options.maxFiles) {
          limitReached ??= "file_limit";
          break;
        }
        files.push(absolutePath);
      }
    }
    if (limitReached) break;
  }

  return {
    files,
    directoriesScanned,
    entriesScanned,
    unreadableDirectories,
    ignoredPaths,
    filteredFiles,
    limitReached,
    truncated: limitReached !== null,
  };
}

function defaultWalkOptions(maxResults: number): WalkFilesOptions {
  return {
    maxFiles: maxResults,
    maxDirectories: maxResults,
    maxEntries: Math.min(20_000, Math.max(1_000, maxResults * 4)),
  };
}
