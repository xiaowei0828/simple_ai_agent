import { readFile } from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "../tools/files.js";

export interface MarkdownDocument {
  path: string;
  title: string;
}

const MAX_DOCUMENTS = 100;

export async function discoverMarkdownDocuments(workspaceRoot: string): Promise<MarkdownDocument[]> {
  const files = await walkFiles(workspaceRoot, 2_000);
  const documents: MarkdownDocument[] = [];

  for (const file of files) {
    if (path.extname(file).toLowerCase() !== ".md") continue;
    if (["AGENTS.md", "AGENTS.override.md", "SKILL.md"].includes(path.basename(file))) continue;

    let beginning = "";
    try {
      beginning = (await readFile(file, "utf8")).slice(0, 4_000);
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
