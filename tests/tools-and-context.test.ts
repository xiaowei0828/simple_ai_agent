import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentInstructions } from "../src/context/build-instructions.js";
import {
  loadProjectInstructions,
  MAX_PROJECT_INSTRUCTION_BYTES,
} from "../src/context/instruction-loader.js";
import { discoverSkills } from "../src/context/skill-registry.js";
import {
  assertSafeRelativePath,
  resolveExistingWorkspacePath,
} from "../src/policy/path-policy.js";
import { resolvePatchPath } from "../src/tools/patch-paths.js";
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
    await expect(resolvePatchPath(root, "config-alias/new.json"))
      .rejects.toThrow("blocked");
    await expect(resolvePatchPath(root, "settings-link/new.json"))
      .rejects.toThrow("sensitive");
  });
});

describe("context discovery", () => {
  it("includes the actual command execution semantics in model instructions", () => {
    const instructions = buildAgentInstructions(
      { files: [], content: "project rule" },
      "",
      {
        platform: "darwin",
        architecture: "arm64",
        shell: { executable: "/bin/fish", displayName: "fish" },
      },
    );

    expect(instructions).toContain("Runtime: darwin/arm64");
    expect(instructions).toContain("macOS/BSD command conventions");
    expect(instructions).toContain("Shell: fish (/bin/fish), non-interactive");
    expect(instructions).toContain("Respect tool approval requirements");
    expect(instructions).toContain("use apply_patch for file changes");
    expect(instructions).toContain("read its SKILL.md before acting");
    expect(instructions.length).toBeLessThan(1_500);
  });

  it("omits empty project and skill sections", () => {
    const instructions = buildAgentInstructions(
      { files: [], content: "" },
      "",
      { platform: "linux", architecture: "x64" },
    );

    expect(instructions).not.toContain("# Project instructions");
    expect(instructions).not.toContain("# Available skills");
  });

  it("loads only the root AGENTS.md", async () => {
    const root = await createTempDirectory("simple-code-agent-instructions-");
    const child = path.join(root, "packages", "app");
    await mkdir(child, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "root rule", "utf8");
    await writeFile(path.join(child, "AGENTS.md"), "nested rule", "utf8");
    await writeFile(path.join(child, "AGENTS.override.md"), "ignored override", "utf8");

    const loaded = await loadProjectInstructions(root);

    expect(loaded.content).toContain("root rule");
    expect(loaded.content).not.toContain("nested rule");
    expect(loaded.content).not.toContain("ignored override");
    expect(loaded.files).toEqual([path.join(root, "AGENTS.md")]);
    expect(loaded.warning).toBeUndefined();
  });

  it("limits oversized root instructions without splitting UTF-8 characters", async () => {
    const root = await createTempDirectory("simple-code-agent-large-instructions-");
    await writeFile(
      path.join(root, "AGENTS.md"),
      "你".repeat(Math.ceil(MAX_PROJECT_INSTRUCTION_BYTES / 3) + 10),
      "utf8",
    );

    const loaded = await loadProjectInstructions(root);

    expect(Buffer.byteLength(loaded.content, "utf8")).toBeLessThanOrEqual(
      MAX_PROJECT_INSTRUCTION_BYTES,
    );
    expect(loaded.content).not.toContain("\uFFFD");
    expect(loaded.warning).toContain("was truncated");
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
    }]);
  });

});
