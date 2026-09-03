import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "../src/context/skill-registry.js";

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

});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
