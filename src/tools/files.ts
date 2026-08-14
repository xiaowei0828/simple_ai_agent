import { readdir } from "node:fs/promises";
import path from "node:path";

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".agent-runs",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".json", ".jsx", ".kt", ".md", ".mjs", ".php", ".py",
  ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".xml", ".yaml", ".yml",
]);

const TEXT_FILENAMES = new Set(["Dockerfile", "Makefile", "AGENTS.md", "SKILL.md"]);

export function isLikelyTextFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return TEXT_FILENAMES.has(basename) || TEXT_EXTENSIONS.has(path.extname(basename).toLowerCase());
}

export async function walkFiles(root: string, maxResults: number): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    if (files.length >= maxResults) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxResults) break;
      if (entry.name.startsWith(".env") || entry.name === ".DS_Store") continue;

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await visit(root);
  return files;
}
