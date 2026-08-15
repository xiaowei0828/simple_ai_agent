import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SkillMetadata } from "../context/skill-registry.js";
import type { AgentTool } from "./types.js";

const MAX_SKILL_CHARS = 40_000;
const MAX_SKILL_BYTES = 1_000_000;

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function createLoadSkillTool(
  skills: SkillMetadata[],
): AgentTool<{ name: string; resource: string }> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const names = skills.map((skill) => skill.name);
  const inputSchema = z.object({
    name: z.string().min(1),
    resource: z.string().min(1),
  }).strict();

  return {
    risk: "read",
    definition: {
      type: "function",
      name: "load_skill",
      description:
        "Load a skill entry point or one of its referenced UTF-8 resources. Use resource=\"SKILL.md\" for the entry point; otherwise pass a path relative to that skill's directory. To reference another skill, call load_skill with that skill's name.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: names },
          resource: {
            type: "string",
            minLength: 1,
            description: "Use SKILL.md for the entry point, or a skill-relative path such as references/workflow.md.",
          },
        },
        required: ["name", "resource"],
        additionalProperties: false,
      },
    },
    parse(input) {
      const parsed = inputSchema.parse(input);
      if (!byName.has(parsed.name)) throw new Error(`Unknown skill: ${parsed.name}`);
      if (path.isAbsolute(parsed.resource)) {
        throw new Error("Skill resource paths must be relative.");
      }
      return parsed;
    },
    async execute(input) {
      const skill = byName.get(input.name);
      if (!skill) throw new Error(`Unknown skill: ${input.name}`);

      const mainFile = await realpath(skill.filePath);
      const skillRoot = path.dirname(mainFile);
      let resourcePath = mainFile;
      if (input.resource !== "SKILL.md") {
        const lexicalCandidate = path.resolve(skillRoot, input.resource);
        if (!isInside(skillRoot, lexicalCandidate) || lexicalCandidate === skillRoot) {
          throw new Error("Skill resource path escapes the selected skill directory.");
        }
        resourcePath = await realpath(lexicalCandidate);
        if (!isInside(skillRoot, resourcePath)) {
          throw new Error("Skill resource resolves outside the selected skill directory.");
        }
      }

      const metadata = await stat(resourcePath);
      if (!metadata.isFile()) throw new Error("load_skill only accepts files.");
      if (metadata.size > MAX_SKILL_BYTES) {
        throw new Error(`Skill file exceeds ${MAX_SKILL_BYTES} bytes.`);
      }
      const content = await readFile(resourcePath, "utf8");
      if (content.includes("\0")) throw new Error("Binary skill resources are not supported.");
      return {
        name: skill.name,
        resource: input.resource,
        content: content.slice(0, MAX_SKILL_CHARS),
        truncated: content.length > MAX_SKILL_CHARS,
      };
    },
  };
}
