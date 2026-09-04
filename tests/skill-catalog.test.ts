import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillCatalog, MAX_SKILL_CATALOG_CHARS } from "../src/context/skill-catalog.js";
import { discoverSkills, type SkillMetadata } from "../src/context/skill-registry.js";
import { buildAgentInstructions } from "../src/context/build-instructions.js";
import { AgentRunner } from "../src/core/agent-runner.js";
import type { ModelRequest, ModelResponse, ToolCallOutput } from "../src/core/types.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { createTempDirectoryFixture } from "./test-utils.js";

const createTempDirectory = createTempDirectoryFixture();

function quotePath(filePath: string): string {
  return process.platform === "win32"
    ? `'${filePath.replace(/'/g, "''")}'`
    : `'${filePath.replace(/'/g, "'\\''")}'`;
}

function readLines(filePath: string, first: number, last: number): string {
  return process.platform === "win32"
    ? `Get-Content -LiteralPath ${quotePath(filePath)} -Encoding UTF8 | Select-Object -Skip ${first - 1} -First ${last - first + 1}`
    : `sed -n '${first},${last}p' ${quotePath(filePath)}`;
}

function commandOutput(request: ModelRequest): string {
  const output = (request.input as ToolCallOutput[])[0]!;
  const payload = JSON.parse(output.output);
  expect(payload.ok).toBe(true);
  expect(payload.result.exitCode).toBe(0);
  expect(payload.result.truncated).toBe(false);
  return payload.result.output;
}

describe("skill catalog", () => {
  it("preserves complete descriptions and absolute paths without loading a large skill body", async () => {
    const root = await createTempDirectory("simple-agent-skill-body-");
    const skillDir = path.join(root, "review");
    await mkdir(skillDir);
    const description = `${"Detailed trigger information. ".repeat(10)}unique-tail-trigger`;
    await writeFile(path.join(skillDir, "SKILL.md"),
      `---\nname: review\ndescription: ${description}\n---\n${"BODY-ONLY\n".repeat(100_000)}`);
    const catalog = createSkillCatalog(await discoverSkills([root]));
    expect(catalog.content).toContain(description);
    expect(catalog.content).toContain(path.join(skillDir, "SKILL.md"));
    expect(catalog.content).not.toContain("BODY-ONLY");
    expect(catalog.content.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(catalog).toMatchObject({ includedSkills: 1, omittedSkills: 0 });
    const instructions = buildAgentInstructions({ files: [], content: "" }, catalog.content);
    expect(instructions).toContain(catalog.content);
    expect(instructions).toContain("read its SKILL.md before acting");
  });

  it("shortens descriptions and omits trailing skills when the inline budget is exceeded", () => {
    const skills: SkillMetadata[] = Array.from({ length: 3_000 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Full description ${index}. ${"Trigger information. ".repeat(10)}`,
      filePath: path.resolve(`skill group/${index}/SKILL.md`),
    }));
    const catalog = createSkillCatalog(skills);
    expect(catalog.content.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(catalog.content).toContain("skill-0");
    expect(catalog.content).not.toContain("skill-2999");
    expect(catalog.shortenedDescriptions).toBe(3_000);
    expect(catalog.omittedSkills).toBeGreaterThan(0);
    expect(catalog.includedSkills + catalog.omittedSkills).toBe(skills.length);
    expect(catalog.warning).toContain("omitted from model context");
  });

  it("keeps every skill when shortening descriptions is enough", () => {
    const skills: SkillMetadata[] = Array.from({ length: 25 }, (_, index) => ({
      name: `skill-${index}`,
      description: `${"Useful trigger details. ".repeat(30)}tail-${index}`,
      filePath: path.resolve(`skills/${index}/SKILL.md`),
    }));
    const catalog = createSkillCatalog(skills);
    expect(catalog.content.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(catalog).toMatchObject({
      includedSkills: skills.length,
      omittedSkills: 0,
      shortenedDescriptions: skills.length,
    });
    expect(catalog.content).not.toContain("tail-0");
    expect(catalog.warning).toBeUndefined();
  });

  it("shortens one oversized description while preserving the skill and path", () => {
    const skill = {
      name: "quoted \"skill\"\nname",
      description: "x".repeat(MAX_SKILL_CATALOG_CHARS) + " final keyword",
      filePath: path.resolve("skill's 中文 folder/SKILL.md"),
    };
    const catalog = createSkillCatalog([skill]);
    expect(catalog.content.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(catalog.content).toContain("quoted &quot;skill&quot;&#10;name");
    expect(catalog.content).toContain("skill&apos;s 中文 folder/SKILL.md");
    expect(catalog.content).not.toContain("final keyword");
    expect(catalog).toMatchObject({
      includedSkills: 1,
      omittedSkills: 0,
      shortenedDescriptions: 1,
    });
  });

  it("emits no skill context for an empty registry", () => {
    const catalog = createSkillCatalog([]);
    expect(catalog.content).toBe("");
    expect(catalog).toMatchObject({ includedSkills: 0, omittedSkills: 0 });
  });

  it("reads an included skill and its external resources through approved commands", async () => {
    const root = await createTempDirectory("simple-agent-skills-flow-");
    const workspace = path.join(root, "workspace");
    const skillDir = path.join(root, "skill's 中文 folder");
    await mkdir(workspace);
    await mkdir(path.join(skillDir, "references"), { recursive: true });
    const target: SkillMetadata = {
      name: "last-skill",
      description: `${"Useful workflow. ".repeat(20)}unique-tail-trigger`,
      filePath: path.join(skillDir, "SKILL.md"),
    };
    await writeFile(target.filePath, `${"padding\n".repeat(499)}Read references/checks.md\n`);
    await writeFile(path.join(skillDir, "references/checks.md"), "External reference content\n");
    const catalog = createSkillCatalog([target]);
    const requests: ModelRequest[] = [];
    const approvedCommands: string[] = [];
    const call = (command: string): ModelResponse => ({
      id: `response-${requests.length}`, outputText: "",
      toolCalls: [{ callId: `call-${requests.length}`, name: "run_command", arguments: JSON.stringify({ command }) }],
    });
    const runner = new AgentRunner({
      model: {
        async respond(request) {
          requests.push(request);
          expect(request.tools.map((tool) => tool.name)).toEqual(["apply_patch", "run_command"]);
          if (requests.length === 1) {
            expect(request.instructions).toContain("skill&apos;s 中文 folder/SKILL.md");
            return call(readLines(target.filePath, 500, 500));
          }
          if (requests.length === 2) {
            expect(commandOutput(request).trim()).toBe("Read references/checks.md");
            return call(readLines(path.join(skillDir, "references/checks.md"), 1, 20));
          }
          expect(commandOutput(request).trim()).toBe("External reference content");
          return { id: "done", outputText: "Read the selected skill and reference.", toolCalls: [] };
        },
      },
      modelName: "fixture",
      instructions: buildAgentInstructions({ files: [], content: "" }, catalog.content),
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: workspace },
      approvalPolicy: {
        async approve(request) {
          expect(request.toolName).toBe("run_command");
          expect(request.risk).toBe("execute");
          approvedCommands.push((request.arguments as { command: string }).command);
          return true;
        },
      },
    });
    await expect(runner.run("Find the unique-tail-trigger workflow.")).resolves.toMatchObject({ steps: 3 });
    expect(approvedCommands).toHaveLength(2);
  });
});
