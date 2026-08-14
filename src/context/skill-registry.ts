import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface SkillMetadata {
  name: string;
  description: string;
  routing?: string;
  filePath: string;
}

const MAX_CATALOG_DESCRIPTION_CHARS = 80;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseMetadata(
  content: string,
  fallbackName: string,
): Pick<SkillMetadata, "name" | "description" | "routing"> {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter?.[1]) {
    return { name: fallbackName, description: "Local workflow instructions." };
  }

  const values = new Map<string, string>();
  for (const line of frontmatter[1].split("\n")) {
    const match = line.match(/^([A-Za-z_-]+):\s*(.+)$/);
    if (match?.[1] && match[2]) values.set(match[1], unquote(match[2]));
  }
  return {
    name: values.get("name") ?? fallbackName,
    description: values.get("description") ?? "Local workflow instructions.",
    ...(values.has("routing") ? { routing: values.get("routing") } : {}),
  };
}

export async function discoverSkills(roots: string[]): Promise<SkillMetadata[]> {
  const skills = new Map<string, SkillMetadata>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(root, entry.name, "SKILL.md");
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const metadata = parseMetadata(content.slice(0, 10_000), entry.name);
      if (!skills.has(metadata.name)) {
        skills.set(metadata.name, { ...metadata, filePath });
      }
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatSkillCatalog(skills: SkillMetadata[]): string {
  if (skills.length === 0) return "No local skills were discovered.";
  return skills
    .map((skill) => `- ${skill.name}: ${compactDescription(skill.routing ?? skill.description)}`)
    .join("\n");
}

function compactDescription(description: string): string {
  const compact = description.replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_CATALOG_DESCRIPTION_CHARS) return compact;
  return `${compact.slice(0, MAX_CATALOG_DESCRIPTION_CHARS - 1)}…`;
}
