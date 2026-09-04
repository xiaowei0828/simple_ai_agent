import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
    const catalog = await createSkillCatalog(await discoverSkills([root]));
    try {
      expect(catalog.indexPath).toBeUndefined();
      expect(catalog.content).toContain(description);
      expect(catalog.content).toContain(JSON.stringify(path.join(skillDir, "SKILL.md")));
      expect(catalog.content).not.toContain("BODY-ONLY");
      expect(catalog.content.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
      const instructions = buildAgentInstructions({ files: [], content: "" }, catalog.content);
      expect(instructions).toContain(catalog.content);
      expect(instructions).toContain("bounded line ranges until complete");
    } finally {
      await catalog.dispose();
    }
  });

  it("keeps every entry searchable when thousands of skills exceed the inline budget", async () => {
    const skills: SkillMetadata[] = Array.from({ length: 3_000 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Full description ${index}. ${"Trigger information. ".repeat(10)}`,
      filePath: path.resolve(`skill group/${index}/SKILL.md`),
    }));
    const catalog = await createSkillCatalog(skills);
    const indexPath = catalog.indexPath!;
    try {
      expect(catalog.content.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
      expect(catalog.content).toContain("3000 skill(s)");
      expect(catalog.content).toContain(JSON.stringify(indexPath));
      expect(catalog.content).not.toContain(skills[0]!.description);
      const records = (await readFile(indexPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toEqual(skills);
    } finally {
      await catalog.dispose();
    }
    await expect(access(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("indexes even one oversized record without clipping its description or path", async () => {
    const skill = {
      name: "quoted \"skill\"\nname",
      description: "x".repeat(MAX_SKILL_CATALOG_CHARS) + " final keyword",
      filePath: path.resolve("skill's 中文 folder/SKILL.md"),
    };
    const catalog = await createSkillCatalog([skill]);
    try {
      expect(catalog.content.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
      const lines = (await readFile(catalog.indexPath!, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual(skill);
    } finally {
      await catalog.dispose();
    }
  });

  it("emits no skill context for an empty registry", async () => {
    const catalog = await createSkillCatalog([]);
    expect(catalog.content).toBe("");
    expect(catalog.indexPath).toBeUndefined();
    await catalog.dispose();
  });

  it("finds a late skill by description and reads external skill resources through approved commands", async () => {
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
    const skills: SkillMetadata[] = Array.from({ length: 100 }, (_, index) => ({
      name: `other-${index}`, description: "Unrelated workflow.", filePath: path.resolve(`other-${index}/SKILL.md`),
    }));
    const catalog = await createSkillCatalog([...skills, target]);
    try {
      const requests: ModelRequest[] = [];
      const approvedCommands: string[] = [];
      const call = (command: string): ModelResponse => ({
        id: `response-${requests.length}`, outputText: "",
        toolCalls: [{ callId: `call-${requests.length}`, name: "run_command", arguments: JSON.stringify({ command }) }],
      });
      let selectedPath: string;
      const runner = new AgentRunner({
        model: {
          async respond(request) {
            requests.push(request);
            expect(request.tools.map((tool) => tool.name)).toEqual(["apply_patch", "run_command"]);
            if (requests.length === 1) {
              return call(`rg -n -F -- unique-tail-trigger ${quotePath(catalog.indexPath!)}`);
            }
            if (requests.length === 2) {
              const line = commandOutput(request).trim();
              const skill = JSON.parse(line.slice(line.indexOf(":") + 1));
              expect(skill.name).toBe(target.name);
              selectedPath = skill.filePath;
              return call(readLines(selectedPath, 500, 500));
            }
            if (requests.length === 3) {
              expect(commandOutput(request).trim()).toBe("Read references/checks.md");
              return call(readLines(path.join(path.dirname(selectedPath), "references/checks.md"), 1, 20));
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
      await expect(runner.run("Find the unique-tail-trigger workflow.")).resolves.toMatchObject({ steps: 4 });
      expect(approvedCommands).toHaveLength(3);
    } finally {
      await catalog.dispose();
    }
  });
});
