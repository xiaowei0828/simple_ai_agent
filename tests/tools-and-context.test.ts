import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentInstructions } from "../src/context/build-instructions.js";
import { loadProjectInstructions } from "../src/context/instruction-loader.js";
import { discoverMarkdownDocuments } from "../src/context/document-catalog.js";
import { discoverSkills, formatSkillCatalog } from "../src/context/skill-registry.js";
import { resolveExistingWorkspacePath } from "../src/policy/path-policy.js";
import { createDeleteFileTool } from "../src/tools/delete-file.js";
import { createListDirectoryTool } from "../src/tools/list-directory.js";
import { createLoadSkillTool } from "../src/tools/load-skill.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createReplaceInFileTool } from "../src/tools/replace-in-file.js";
import { createWriteFileTool } from "../src/tools/write-file.js";

describe("workspace path policy", () => {
  it("blocks lexical and symbolic-link workspace escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "simple-code-agent-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(root, "escape"));

    await expect(resolveExistingWorkspacePath(root, "../secret.txt")).rejects.toThrow("escapes");
    await expect(resolveExistingWorkspacePath(root, "escape/secret.txt")).rejects.toThrow("symbolic link");
  });

  it("blocks common secret files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-secret-"));
    await writeFile(path.join(root, ".env"), "TOKEN=secret", "utf8");
    await expect(resolveExistingWorkspacePath(root, ".env")).rejects.toThrow("sensitive");
  });

  it("blocks agent trace logs from being read back into model context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-trace-policy-"));
    await mkdir(path.join(root, ".agent-runs"));
    await writeFile(path.join(root, ".agent-runs", "run.jsonl"), "{}\n", "utf8");

    await expect(resolveExistingWorkspacePath(root, ".agent-runs/run.jsonl")).rejects.toThrow("blocked");
  });

  it("blocks local application configuration from model file tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-config-policy-"));
    await mkdir(path.join(root, ".config"));
    await writeFile(path.join(root, ".config", "config.json"), "{}\n", "utf8");

    await expect(resolveExistingWorkspacePath(root, ".config/config.json")).rejects.toThrow("blocked");
  });
});

describe("replace_in_file", () => {
  it("performs only an exact, count-checked replacement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-edit-"));
    const filePath = path.join(root, "file.ts");
    await writeFile(filePath, "const value = 1;\n", "utf8");
    const tool = createReplaceInFileTool();

    await expect(tool.execute({
      path: "file.ts",
      oldText: "missing",
      newText: "value",
      expectedOccurrences: 1,
    }, { workspaceRoot: root })).rejects.toThrow("No changes");
    expect(await readFile(filePath, "utf8")).toContain("value = 1");

    await tool.execute({
      path: "file.ts",
      oldText: "value = 1",
      newText: "value = 2",
      expectedOccurrences: 1,
    }, { workspaceRoot: root });
    expect(await readFile(filePath, "utf8")).toContain("value = 2");
  });
});

describe("write_file", () => {
  it("creates a file with exact content and does not add a newline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-write-file-"));
    const tool = createWriteFileTool();
    const input = tool.parse({ path: "result.txt", content: "123456", overwrite: false });

    await expect(tool.execute(input, { workspaceRoot: root })).resolves.toEqual({
      path: "result.txt",
      created: true,
      overwritten: false,
      bytesWritten: 6,
    });
    expect(await readFile(path.join(root, "result.txt"), "utf8")).toBe("123456");
  });

  it("requires an explicit overwrite and preserves the old content when denied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-write-existing-"));
    const filePath = path.join(root, "result.txt");
    await writeFile(filePath, "old", "utf8");
    const tool = createWriteFileTool();

    await expect(tool.execute({
      path: "result.txt",
      content: "new",
      overwrite: false,
    }, { workspaceRoot: root })).rejects.toThrow("already exists");
    expect(await readFile(filePath, "utf8")).toBe("old");

    await expect(tool.execute({
      path: "result.txt",
      content: "new",
      overwrite: true,
    }, { workspaceRoot: root })).resolves.toMatchObject({
      created: false,
      overwritten: true,
      bytesWritten: 3,
    });
    expect(await readFile(filePath, "utf8")).toBe("new");
  });

  it("blocks symbolic links and sensitive paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-write-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "simple-code-agent-write-outside-"));
    const outsideFile = path.join(outside, "outside.txt");
    await writeFile(outsideFile, "outside", "utf8");
    await symlink(outsideFile, path.join(root, "linked.txt"));
    await symlink(outside, path.join(root, "escape"));
    const tool = createWriteFileTool();

    await expect(tool.execute({
      path: "linked.txt",
      content: "changed",
      overwrite: true,
    }, { workspaceRoot: root })).rejects.toThrow("symbolic links");
    await expect(tool.execute({
      path: "escape/new.txt",
      content: "changed",
      overwrite: false,
    }, { workspaceRoot: root })).rejects.toThrow("symbolic link");
    await expect(tool.execute({
      path: ".env",
      content: "TOKEN=value",
      overwrite: false,
    }, { workspaceRoot: root })).rejects.toThrow("sensitive");
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
  });
});

describe("delete_file", () => {
  it("deletes one workspace file and is classified as a write operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-delete-file-"));
    const filePath = path.join(root, "obsolete.txt");
    await writeFile(filePath, "obsolete", "utf8");
    const tool = createDeleteFileTool();

    expect(tool.risk).toBe("write");
    await expect(tool.execute({ path: "obsolete.txt" }, { workspaceRoot: root })).resolves.toEqual({
      path: "obsolete.txt",
      deleted: true,
      entryType: "file",
      bytesBefore: 8,
    });
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes a symbolic link without deleting its external target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-delete-link-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "simple-code-agent-delete-link-outside-"));
    const outsideFile = path.join(outside, "keep.txt");
    const linkPath = path.join(root, "linked.txt");
    await writeFile(outsideFile, "keep", "utf8");
    await symlink(outsideFile, linkPath);
    const tool = createDeleteFileTool();

    await expect(tool.execute({ path: "linked.txt" }, { workspaceRoot: root })).resolves.toMatchObject({
      deleted: true,
      entryType: "symbolic_link",
    });
    await expect(readFile(linkPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outsideFile, "utf8")).toBe("keep");
  });

  it("refuses directories, sensitive paths, and workspace escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-delete-policy-"));
    await mkdir(path.join(root, "directory"));
    await writeFile(path.join(root, ".env"), "TOKEN=value", "utf8");
    const tool = createDeleteFileTool();

    await expect(tool.execute({ path: "directory" }, { workspaceRoot: root })).rejects.toThrow("Directories");
    await expect(tool.execute({ path: ".env" }, { workspaceRoot: root })).rejects.toThrow("sensitive");
    await expect(tool.execute({ path: "../outside.txt" }, { workspaceRoot: root })).rejects.toThrow("escapes");
  });
});

describe("list_directory", () => {
  it("lists immediate entries first and expands recursively only when requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-list-directory-"));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(root, "node_modules"));
    await mkdir(path.join(root, "build"));
    await mkdir(path.join(root, ".config"));
    await writeFile(path.join(root, "README.md"), "# Example", "utf8");
    await writeFile(path.join(root, "src", "index.ts"), "export {};", "utf8");
    await writeFile(path.join(root, ".env"), "SECRET=value", "utf8");

    const tool = createListDirectoryTool();
    const result = await tool.execute(
      tool.parse({ path: ".", depth: 1, maxResults: 100 }),
      { workspaceRoot: root },
    );

    expect(result).toEqual({
      path: ".",
      depth: 1,
      entries: [
        { path: "docs", type: "directory" },
        { path: "src", type: "directory" },
        { path: "README.md", type: "file" },
      ],
      returnedEntries: 3,
      truncated: false,
    });

    await expect(tool.execute(
      tool.parse({ path: ".", depth: 2, maxResults: 100 }),
      { workspaceRoot: root },
    )).resolves.toMatchObject({
      entries: expect.arrayContaining([{ path: "src/index.ts", type: "file" }]),
      truncated: false,
    });
  });
});

describe("read_file", () => {
  it("treats omitted line bounds as a full-file read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-read-file-"));
    await writeFile(path.join(root, "README.md"), "line one\nline two\n", "utf8");
    const tool = createReadFileTool();

    const parsed = tool.parse({ path: "README.md" });
    expect(parsed).toEqual({ path: "README.md", lineStart: null, lineEnd: null });
    await expect(tool.execute(parsed, { workspaceRoot: root })).resolves.toMatchObject({
      lineStart: 1,
      lineEnd: 3,
      content: "line one\nline two\n",
    });
  });
});

describe("context discovery", () => {
  it("includes the actual command execution semantics in model instructions", () => {
    const instructions = buildAgentInstructions(
      { files: [], content: "project rule" },
      [],
      [],
      {
        platform: "darwin",
        architecture: "arm64",
        shell: { executable: "/bin/fish", displayName: "fish" },
      },
    );

    expect(instructions).toContain("Runtime: darwin/arm64");
    expect(instructions).toContain("macOS/BSD command conventions");
    expect(instructions).toContain("Shell: fish (/bin/fish), non-interactive");
    expect(instructions).toContain("including chaining, pipelines, redirects");
    expect(instructions).toContain("Every run_command call requires host confirmation");
    expect(instructions).toContain("write_file for creation or intentional full replacement");
    expect(instructions).toContain("Load a relevant skill");
  });

  it("omits empty project, document, and skill sections", () => {
    const instructions = buildAgentInstructions(
      { files: [], content: "" },
      [],
      [],
      { platform: "linux", architecture: "x64" },
    );

    expect(instructions).not.toContain("# Project instructions");
    expect(instructions).not.toContain("# Markdown documentation catalog");
    expect(instructions).not.toContain("# Available skills");
  });

  it("loads hierarchical AGENTS files and prefers an override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-instructions-"));
    const child = path.join(root, "packages", "app");
    await mkdir(child, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "root rule", "utf8");
    await writeFile(path.join(child, "AGENTS.md"), "ignored rule", "utf8");
    await writeFile(path.join(child, "AGENTS.override.md"), "child override", "utf8");

    const loaded = await loadProjectInstructions(root, child);

    expect(loaded.content).toContain("root rule");
    expect(loaded.content).toContain("child override");
    expect(loaded.content).not.toContain("ignored rule");
    expect(loaded.files).toHaveLength(2);
  });

  it("discovers skill metadata without loading unrelated assets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-skills-"));
    const skillDirectory = path.join(root, "review");
    await mkdir(skillDirectory);
    await writeFile(path.join(skillDirectory, "SKILL.md"), `---
name: review
description: Review code carefully.
routing: Targeted code review.
---
\n# Workflow`, "utf8");

    const skills = await discoverSkills([root]);

    expect(skills).toMatchObject([{
      name: "review",
      description: "Review code carefully.",
      routing: "Targeted code review.",
    }]);
  });

  it("loads both a skill entry point and its referenced resources through load_skill", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-skill-resource-"));
    const skillDirectory = path.join(root, "review");
    await mkdir(path.join(skillDirectory, "references"), { recursive: true });
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await writeFile(skillPath, "# Main workflow", "utf8");
    await writeFile(path.join(skillDirectory, "references", "checks.md"), "# Checks", "utf8");
    const tool = createLoadSkillTool([{
      name: "review",
      description: "Review code.",
      filePath: skillPath,
    }]);

    await expect(tool.execute(
      tool.parse({ name: "review", resource: null }),
      { workspaceRoot: root },
    )).resolves.toMatchObject({
      name: "review",
      resource: "SKILL.md",
      content: "# Main workflow",
    });
    await expect(tool.execute(
      tool.parse({ name: "review", resource: "references/checks.md" }),
      { workspaceRoot: root },
    )).resolves.toMatchObject({
      name: "review",
      resource: "references/checks.md",
      content: "# Checks",
    });
    await expect(tool.execute(
      tool.parse({ name: "review", resource: "../outside.md" }),
      { workspaceRoot: root },
    )).rejects.toThrow("escapes");
  });

  it("compacts long skill descriptions in the advertised catalog", () => {
    const description = "A".repeat(300);
    const catalog = formatSkillCatalog([{
      name: "large",
      description,
      routing: "Short routing description.",
      filePath: "/unused/SKILL.md",
    }]);

    expect(catalog.length).toBeLessThan(description.length);
    expect(catalog).toContain("Short routing description.");
    expect(catalog).not.toContain("AAA");
  });

  it("indexes Markdown paths and headings without treating AGENTS.md as a regular document", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-docs-"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "AGENTS.md"), "agent rules", "utf8");
    await writeFile(path.join(root, "docs", "architecture.md"), "# Runtime architecture\n\nDetails", "utf8");

    const documents = await discoverMarkdownDocuments(root);

    expect(documents).toEqual([{ path: "docs/architecture.md", title: "Runtime architecture" }]);
  });
});
