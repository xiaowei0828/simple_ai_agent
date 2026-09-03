import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../policy/path-policy.js";
import { readUtf8Prefix } from "./read-prefix.js";

export interface SkillMetadata {
  name: string;
  description: string;
  routing?: string;
  filePath: string;
}

const MAX_SKILL_METADATA_BYTES = 10_000;

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
  const canonicalFilesByName = new Map<string, string>();
  const visitedRoots = new Set<string>();
  for (const root of roots) {
    const absoluteRoot = path.resolve(root);
    let canonicalSkillsRoot: string;
    let entries: import("node:fs").Dirent[];
    try {
      canonicalSkillsRoot = await realpath(absoluteRoot);
      if (visitedRoots.has(canonicalSkillsRoot)) continue;
      visitedRoots.add(canonicalSkillsRoot);
      entries = await readdir(absoluteRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDirectory = path.join(absoluteRoot, entry.name);
      const filePath = path.join(skillDirectory, "SKILL.md");
      let content: string;
      let canonicalFile: string;
      try {
        const [canonicalRoot, resolvedFile] = await Promise.all([
          realpath(skillDirectory),
          realpath(filePath),
        ]);
        canonicalFile = resolvedFile;
        if (!isPathInside(canonicalSkillsRoot, canonicalRoot)) {
          throw new Error(
            `Skill directory '${skillDirectory}' resolves outside its configured root '${absoluteRoot}'.`,
          );
        }
        if (!isPathInside(canonicalRoot, canonicalFile)) {
          throw new Error(
            `Skill entry point '${filePath}' resolves outside its declared directory '${skillDirectory}'.`,
          );
        }
        content = await readUtf8Prefix(canonicalFile, MAX_SKILL_METADATA_BYTES);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const metadata = parseMetadata(content, entry.name);
      const existing = skills.get(metadata.name);
      if (existing) {
        if (canonicalFilesByName.get(metadata.name) === canonicalFile) continue;
        throw new Error(
          `Duplicate skill name '${metadata.name}' discovered in '${existing.filePath}' and '${filePath}'.`,
        );
      }
      skills.set(metadata.name, { ...metadata, filePath });
      canonicalFilesByName.set(metadata.name, canonicalFile);
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
