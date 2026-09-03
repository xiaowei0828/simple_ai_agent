import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillMetadata } from "./skill-registry.js";

export const MAX_SKILL_CATALOG_CHARS = 8_000;

export interface SkillCatalog {
  content: string;
  indexPath?: string;
  dispose(): Promise<void>;
}

/** Keep metadata searchable without putting every skill into the model context. */
export async function createSkillCatalog(skills: SkillMetadata[]): Promise<SkillCatalog> {
  const records = skills.map((skill) => JSON.stringify({
    name: skill.name,
    description: skill.description,
    ...(skill.routing ? { routing: skill.routing } : {}),
    filePath: path.resolve(skill.filePath),
  }));
  const metadata = records.join("\n");
  const inline = skills.length === 0 ? "" : `${skills.length} skill(s). Metadata (JSONL):\n${metadata}`;
  if (inline.length <= MAX_SKILL_CATALOG_CHARS) {
    return { content: inline, async dispose() {} };
  }

  const directory = await mkdtemp(path.join(tmpdir(), "simple-code-agent-skills-"));
  const indexPath = path.join(directory, "index.jsonl");
  try {
    await writeFile(indexPath, `${metadata}\n`, "utf8");
    const content = `${skills.length} skill(s) are available. Their metadata exceeds the ${MAX_SKILL_CATALOG_CHARS}-character inline budget.
Complete skill index: ${JSON.stringify(indexPath)}
The index is JSONL with one skill per line: name, description, optional routing, and absolute filePath. It contains metadata only, not skill bodies.
Use run_command to search this file with rg -n -i -- 'task keywords' before choosing a skill. Match names and descriptions, try synonyms if needed, and narrow overly broad matches. For an explicit skill request, search its name first. Decode the matching JSON record to get filePath, then read that SKILL.md. Do not dump the entire index. If rg is unavailable, use the active shell's text search commands.`;
    if (content.length > MAX_SKILL_CATALOG_CHARS) {
      throw new Error("The skill index path is too long for the catalog context budget.");
    }
    return { content, indexPath, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
