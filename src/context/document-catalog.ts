import path from "node:path";
import { readUtf8Prefix } from "./read-prefix.js";
import { walkFiles } from "./walk-files.js";

export interface MarkdownDocument {
  path: string;
  title: string;
}

const MAX_DOCUMENTS = 100;

export async function discoverMarkdownDocuments(workspaceRoot: string): Promise<MarkdownDocument[]> {
  const files = await walkFiles(workspaceRoot, {
    maxFiles: 2_000,
    maxDirectories: 2_000,
    maxEntries: 8_000,
    includeFile: (file) => path.extname(file).toLowerCase() === ".md"
      && !["AGENTS.md", "AGENTS.override.md", "SKILL.md"].includes(path.basename(file)),
  });
  const documents: MarkdownDocument[] = [];

  for (const file of files) {
    let beginning = "";
    try {
      beginning = (await readUtf8Prefix(file, 16_000)).slice(0, 4_000);
    } catch {
      continue;
    }
    const heading = beginning.match(/^#\s+(.+)$/m)?.[1]?.trim();
    documents.push({
      path: path.relative(workspaceRoot, file).split(path.sep).join("/"),
      title: heading || path.basename(file),
    });
    if (documents.length >= MAX_DOCUMENTS) break;
  }

  return documents;
}

export function formatDocumentCatalog(documents: MarkdownDocument[]): string {
  if (documents.length === 0) return "No Markdown documentation was discovered.";
  return documents.map((document) => `- ${document.path}: ${document.title}`).join("\n");
}
