import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SkillMetadata } from "../context/skill-registry.js";
import type { AgentTool } from "./types.js";

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SKILL_CHUNK_CHARS = 15_000;

interface LoadSkillInput {
  name: string;
  resource: string;
  offset: number | null;
  limit: number | null;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function createLoadSkillTool(
  skills: SkillMetadata[],
): AgentTool<LoadSkillInput> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const names = skills.map((skill) => skill.name);
  const inputSchema = z.object({
    name: z.string().min(1),
    resource: z.string().min(1),
    offset: z.number().int().nonnegative().nullable().default(null),
    limit: z.number().int().min(1).max(MAX_SKILL_CHUNK_CHARS).nullable().default(null),
  }).strict();

  return {
    risk: "read",
    executionMode: "parallel",
    definition: {
      type: "function",
      name: "load_skill",
      description:
        "Load a chunk of a skill entry point or one of its referenced UTF-8 resources. Use resource=\"SKILL.md\" for the entry point; otherwise pass a path relative to that skill's directory. Start with offset=null and limit=null; if nextOffset is returned, continue from that character offset until truncated is false.",
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
          offset: {
            type: ["integer", "null"],
            minimum: 0,
            description: "Zero-based character offset; null starts at the beginning.",
          },
          limit: {
            type: ["integer", "null"],
            minimum: 1,
            maximum: MAX_SKILL_CHUNK_CHARS,
            description: `Maximum characters to return; null uses ${MAX_SKILL_CHUNK_CHARS}.`,
          },
        },
        required: ["name", "resource", "offset", "limit"],
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

      const declaredFile = path.resolve(skill.filePath);
      const declaredRoot = path.dirname(declaredFile);
      const [skillRoot, mainFile] = await Promise.all([
        realpath(declaredRoot),
        realpath(declaredFile),
      ]);
      if (!isInside(skillRoot, mainFile)) {
        throw new Error("Skill entry point resolves outside the selected skill directory.");
      }
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
      const offset = input.offset ?? 0;
      const limit = input.limit ?? MAX_SKILL_CHUNK_CHARS;
      const end = Math.min(content.length, offset + limit);
      const truncated = end < content.length;
      return {
        name: skill.name,
        resource: input.resource,
        offset,
        content: content.slice(offset, end),
        totalCharacters: content.length,
        truncated,
        nextOffset: truncated ? end : null,
      };
    },
  };
}
