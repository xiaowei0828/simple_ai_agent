import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentInstructions } from "../src/context/build-instructions.js";
import { loadProjectInstructions } from "../src/context/instruction-loader.js";
import { discoverMarkdownDocuments } from "../src/context/document-catalog.js";
import { discoverSkills } from "../src/context/skill-registry.js";
import {
  assertSafeRelativePath,
  resolveExistingWorkspacePath,
  createWorkspacePathResolver,
} from "../src/policy/path-policy.js";
import { walkFiles } from "../src/context/walk-files.js";
import { createTempDirectoryFixture } from "./test-utils.js";

const createTempDirectory = createTempDirectoryFixture();

describe("workspace path policy", () => {
  it("blocks lexical and symbolic-link workspace escapes", async () => {
    const root = await createTempDirectory("simple-code-agent-root-");
    const outside = await createTempDirectory("simple-code-agent-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(root, "escape"));

    await expect(resolveExistingWorkspacePath(root, "../secret.txt")).rejects.toThrow("escapes");
    await expect(resolveExistingWorkspacePath(root, "escape/secret.txt")).rejects.toThrow("symbolic link");
  });

  it("blocks common secret files", async () => {
    const root = await createTempDirectory("simple-code-agent-secret-");
    await writeFile(path.join(root, ".env"), "TOKEN=secret", "utf8");
    await expect(resolveExistingWorkspacePath(root, ".env")).rejects.toThrow("sensitive");
  });

  it("blocks sensitive names in every path segment", () => {
    expect(() => assertSafeRelativePath(".")).not.toThrow();
    expect(() => assertSafeRelativePath(".env/generated/config.txt")).toThrow("sensitive");
    expect(() => assertSafeRelativePath("certificates/private.pem/metadata.txt")).toThrow("sensitive");
    if (process.platform === "win32") {
      expect(() => assertSafeRelativePath("credentials.json:stream")).toThrow("Windows");
      expect(() => assertSafeRelativePath(".git./config")).toThrow("Windows");
      expect(() => assertSafeRelativePath("NUL.txt")).toThrow("Windows");
    }
  });

  it("blocks agent trace paths in the workspace resolver", async () => {
    const root = await createTempDirectory("simple-code-agent-trace-policy-");
    await mkdir(path.join(root, ".agent-runs"));
    await writeFile(path.join(root, ".agent-runs", "run.jsonl"), "{}\n", "utf8");
    await mkdir(path.join(root, ".agent-history"));
    await writeFile(path.join(root, ".agent-history", "conversation.json"), "{}\n", "utf8");

    await expect(resolveExistingWorkspacePath(root, ".agent-runs/run.jsonl")).rejects.toThrow("blocked");
    await expect(resolveExistingWorkspacePath(root, ".agent-history/conversation.json"))
      .rejects.toThrow("blocked");
  });

  it("blocks local application configuration in the workspace resolver", async () => {
    const root = await createTempDirectory("simple-code-agent-config-policy-");
    await mkdir(path.join(root, ".config"));
    await writeFile(path.join(root, ".config", "config.json"), "{}\n", "utf8");

    await expect(resolveExistingWorkspacePath(root, ".config/config.json")).rejects.toThrow("blocked");
  });

  it("matches blocked path segments case-insensitively", () => {
    expect(() => assertSafeRelativePath(".GIT/config")).toThrow("blocked");
    expect(() => assertSafeRelativePath("packages/NODE_MODULES/package.json")).toThrow("blocked");
    expect(() => assertSafeRelativePath(".Agent-Runs/run.jsonl")).toThrow("blocked");
  });

  it("rechecks protected paths after resolving symbolic links", async () => {
    const root = await createTempDirectory("simple-code-agent-canonical-policy-");
    const protectedDirectory = path.join(root, ".config");
    const sensitiveDirectory = path.join(root, ".env");
    await mkdir(protectedDirectory);
    await mkdir(sensitiveDirectory);
    await mkdir(path.join(sensitiveDirectory, "generated"));
    await writeFile(path.join(protectedDirectory, "config.json"), "{}\n", "utf8");
    await symlink(
      protectedDirectory,
      path.join(root, "config-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      sensitiveDirectory,
      path.join(root, "settings-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(resolveExistingWorkspacePath(root, "config-alias/config.json"))
      .rejects.toThrow("blocked");
    await expect(resolveExistingWorkspacePath(root, "settings-link"))
      .rejects.toThrow("sensitive");
    await expect(resolveExistingWorkspacePath(root, "settings-link/generated"))
      .rejects.toThrow("sensitive");
    const resolver = await createWorkspacePathResolver(root);
    await expect(resolver.resolveForMutation("config-alias/new.json"))
      .rejects.toThrow("blocked");
    await expect(resolver.resolveForMutation("settings-link/new.json"))
      .rejects.toThrow("sensitive");
  });
});

describe("workspace file discovery", () => {
  it("stops streaming a large directory at the explicit entry budget", async () => {
    const root = await createTempDirectory("simple-code-agent-walk-budget-");
    await Promise.all(Array.from({ length: 10 }, (_, index) => (
      writeFile(path.join(root, `file-${index}.txt`), "value", "utf8")
    )));

    const result = await walkFiles(root, {
      maxFiles: 10,
      maxDirectories: 10,
      maxEntries: 3,
      includeFile: () => true,
    });

    expect(result).toHaveLength(3);
  });

  it("applies a discovery filter before consuming the file budget", async () => {
    const root = await createTempDirectory("simple-code-agent-walk-filter-");
    await writeFile(path.join(root, "a.log"), "ignore", "utf8");
    await writeFile(path.join(root, "b.log"), "ignore", "utf8");
    await writeFile(path.join(root, "target.ts"), "include", "utf8");

    const result = await walkFiles(root, {
      maxFiles: 1,
      maxDirectories: 1,
      maxEntries: 10,
      includeFile: (file) => file.endsWith(".ts"),
    });

    expect(result.map((file) => path.basename(file))).toEqual(["target.ts"]);
  });
});

describe("context discovery", () => {
  it("includes the actual command execution semantics in model instructions", () => {
    const instructions = buildAgentInstructions(
      { files: [], content: "project rule" },
      "",
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
    expect(instructions).toContain("run_command requires host confirmation");
    expect(instructions).toContain("Use apply_patch for file creation, edits, moves, and deletion");
    expect(instructions).toContain("Load a relevant skill");
  });

  it("omits empty project, document, and skill sections", () => {
    const instructions = buildAgentInstructions(
      { files: [], content: "" },
      "",
      [],
      { platform: "linux", architecture: "x64" },
    );

    expect(instructions).not.toContain("# Project instructions");
    expect(instructions).not.toContain("# Markdown documentation catalog");
    expect(instructions).not.toContain("# Available skills");
  });

  it("loads hierarchical AGENTS files and prefers an override", async () => {
    const root = await createTempDirectory("simple-code-agent-instructions-");
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

  it("accepts a workspace child whose name begins with two dots", async () => {
    const root = await createTempDirectory("simple-code-agent-dot-directory-");
    const child = path.join(root, "..notes");
    await mkdir(child);
    await writeFile(path.join(child, "AGENTS.md"), "child rule", "utf8");
    expect((await loadProjectInstructions(root, child)).content).toContain("child rule");
    await expect(loadProjectInstructions(root, path.dirname(root))).rejects.toThrow("inside workspaceRoot");
  });

  it("discovers skill metadata without loading unrelated assets", async () => {
    const root = await createTempDirectory("simple-code-agent-skills-");
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

  it("indexes Markdown paths and headings without treating AGENTS.md as a regular document", async () => {
    const root = await createTempDirectory("simple-code-agent-docs-");
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "AGENTS.md"), "agent rules", "utf8");
    await writeFile(path.join(root, "docs", "architecture.md"), "# Runtime architecture\n\nDetails", "utf8");

    const documents = await discoverMarkdownDocuments(root);

    expect(documents).toEqual([{ path: "docs/architecture.md", title: "Runtime architecture" }]);
  });
});
