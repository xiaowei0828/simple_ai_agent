import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../src/context/skill-registry.js";
import { createLoadSkillTool } from "../src/tools/load-skill.js";

describe("skill path safety", () => {
  it("rejects a discovered SKILL.md symlink that resolves outside its declared skill directory", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "simple-code-agent-skill-discovery-"));
    const root = path.join(base, "skills");
    const skillDirectory = path.join(root, "review");
    const outsideFile = path.join(base, "outside", "SKILL.md");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(path.dirname(outsideFile), { recursive: true });
    await writeFile(outsideFile, "# Outside workflow", "utf8");
    await symlink(outsideFile, path.join(skillDirectory, "SKILL.md"), "file");

    await expect(discoverSkills([root])).rejects.toThrow(/resolves outside.*declared directory/u);
  });

  it("revalidates the entry point boundary when load_skill executes", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "simple-code-agent-skill-load-"));
    const skillDirectory = path.join(base, "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const outsideFile = path.join(base, "outside", "SKILL.md");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(path.dirname(outsideFile), { recursive: true });
    await writeFile(outsideFile, "# Outside workflow", "utf8");
    await symlink(outsideFile, skillPath, "file");
    const tool = createLoadSkillTool([{
      name: "review",
      description: "Review code.",
      filePath: skillPath,
    }]);

    await expect(tool.execute(
      tool.parse({ name: "review", resource: "SKILL.md" }),
      { workspaceRoot: base },
    )).rejects.toThrow(/entry point resolves outside/u);
  });

  it("reports both sources when two discovered skills declare the same name", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "simple-code-agent-skill-conflict-"));
    const firstRoot = path.join(base, "first");
    const secondRoot = path.join(base, "second");
    const firstSkill = path.join(firstRoot, "review-one", "SKILL.md");
    const secondSkill = path.join(secondRoot, "review-two", "SKILL.md");
    await mkdir(path.dirname(firstSkill), { recursive: true });
    await mkdir(path.dirname(secondSkill), { recursive: true });
    await writeFile(firstSkill, "---\nname: review\ndescription: First.\n---\n", "utf8");
    await writeFile(secondSkill, "---\nname: review\ndescription: Second.\n---\n", "utf8");

    await expect(discoverSkills([firstRoot, secondRoot])).rejects.toThrow(
      new RegExp(`${escapeRegExp(firstSkill)}.*${escapeRegExp(secondSkill)}`, "u"),
    );
  });

  it("keeps loading a normal skill and its in-directory resource", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "simple-code-agent-skill-normal-"));
    const skillDirectory = path.join(base, "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const resourcePath = path.join(skillDirectory, "references", "checks.md");
    await mkdir(path.dirname(resourcePath), { recursive: true });
    await writeFile(skillPath, "# Main workflow", "utf8");
    await writeFile(resourcePath, "# Checks", "utf8");
    const [skill] = await discoverSkills([base]);
    expect(skill).toBeDefined();
    const tool = createLoadSkillTool([skill!]);

    await expect(tool.execute(
      tool.parse({ name: "review", resource: "references/checks.md" }),
      { workspaceRoot: base },
    )).resolves.toMatchObject({ content: "# Checks", truncated: false });
  });

  it("paginates long skill resources with an actionable next offset", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "simple-code-agent-skill-pagination-"));
    const skillDirectory = path.join(base, "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const resourcePath = path.join(skillDirectory, "references", "long.md");
    await mkdir(path.dirname(resourcePath), { recursive: true });
    await writeFile(skillPath, "# Main workflow", "utf8");
    await writeFile(resourcePath, "x".repeat(16_000), "utf8");
    const [skill] = await discoverSkills([base]);
    const tool = createLoadSkillTool([skill!]);

    const first = await tool.execute(tool.parse({
      name: "review",
      resource: "references/long.md",
    }), { workspaceRoot: base }) as {
      content: string;
      nextOffset: number | null;
      truncated: boolean;
    };
    expect(first).toMatchObject({ truncated: true, nextOffset: 15_000 });
    expect(first.content).toHaveLength(15_000);

    await expect(tool.execute(tool.parse({
      name: "review",
      resource: "references/long.md",
      offset: first.nextOffset,
      limit: null,
    }), { workspaceRoot: base })).resolves.toMatchObject({
      offset: 15_000,
      content: "x".repeat(1_000),
      truncated: false,
      nextOffset: null,
    });
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
