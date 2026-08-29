import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentInstructions } from "../src/context/build-instructions.js";
import { loadProjectInstructions } from "../src/context/instruction-loader.js";
import { discoverMarkdownDocuments } from "../src/context/document-catalog.js";
import { discoverSkills, formatSkillCatalog } from "../src/context/skill-registry.js";
import {
  assertSafeRelativePath,
  resolveExistingWorkspacePath,
  resolveWorkspacePathForMutation,
} from "../src/policy/path-policy.js";
import { createDeleteFileTool } from "../src/tools/delete-file.js";
import { walkFilesWithMetadata } from "../src/tools/files.js";
import { createListDirectoryTool } from "../src/tools/list-directory.js";
import { createLoadSkillTool } from "../src/tools/load-skill.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createReplaceInFileTool } from "../src/tools/replace-in-file.js";
import { createSearchCodeTool } from "../src/tools/search-code.js";
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

  it("blocks agent trace logs from being read back into model context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-trace-policy-"));
    await mkdir(path.join(root, ".agent-runs"));
    await writeFile(path.join(root, ".agent-runs", "run.jsonl"), "{}\n", "utf8");
    await mkdir(path.join(root, ".agent-history"));
    await writeFile(path.join(root, ".agent-history", "conversation.json"), "{}\n", "utf8");

    await expect(resolveExistingWorkspacePath(root, ".agent-runs/run.jsonl")).rejects.toThrow("blocked");
    await expect(resolveExistingWorkspacePath(root, ".agent-history/conversation.json"))
      .rejects.toThrow("blocked");
  });

  it("blocks local application configuration from model file tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-config-policy-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-canonical-policy-"));
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
    await expect(resolveWorkspacePathForMutation(root, "config-alias/new.json"))
      .rejects.toThrow("blocked");
    await expect(resolveWorkspacePathForMutation(root, "settings-link/new.json"))
      .rejects.toThrow("sensitive");
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

describe("workspace file discovery", () => {
  it("stops streaming a large directory at the explicit entry budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-walk-budget-"));
    await Promise.all(Array.from({ length: 10 }, (_, index) => (
      writeFile(path.join(root, `file-${index}.txt`), "value", "utf8")
    )));

    const result = await walkFilesWithMetadata(root, {
      maxFiles: 10,
      maxDirectories: 10,
      maxEntries: 3,
    });

    expect(result).toMatchObject({
      entriesScanned: 3,
      limitReached: "entry_limit",
      truncated: true,
    });
    expect(result.files.length).toBeLessThanOrEqual(3);
  });

  it("applies a discovery filter before consuming the file budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-walk-filter-"));
    await writeFile(path.join(root, "a.log"), "ignore", "utf8");
    await writeFile(path.join(root, "b.log"), "ignore", "utf8");
    await writeFile(path.join(root, "target.ts"), "include", "utf8");

    const result = await walkFilesWithMetadata(root, {
      maxFiles: 1,
      maxDirectories: 1,
      maxEntries: 10,
      includeFile: (file) => file.endsWith(".ts"),
    });

    expect(result.files.map((file) => path.basename(file))).toEqual(["target.ts"]);
    expect(result.filteredFiles).toBe(2);
    expect(result.limitReached).toBeNull();
  });
});

describe("search_code", () => {
  it("searches an explicitly named file, including one without a known text extension", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-file-"));
    await writeFile(path.join(root, "build.rules"), "first\nOPENSSL_RAND_WINDOWS\nlast\n", "utf8");
    const tool = createSearchCodeTool();
    const input = tool.parse({
      path: "build.rules",
      query: "OPENSSL_RAND_",
      maxResults: 10,
    });

    await expect(tool.execute(input, { workspaceRoot: root })).resolves.toEqual({
      matches: [{
        path: "build.rules",
        line: 2,
        column: 1,
        text: "OPENSSL_RAND_WINDOWS",
      }],
      truncated: false,
      scan: {
        filesDiscovered: 1,
        filesSearched: 1,
        directoriesScanned: 0,
        entriesScanned: 0,
        bytesRead: 32,
        unreadableDirectories: 0,
        ignoredPaths: 0,
        skippedByGlob: 0,
        skippedByPathPolicy: 0,
        skippedBySize: 0,
        skippedBinaryFiles: 0,
        unreadableFiles: 0,
        matchesFound: 1,
        incomplete: false,
        reasons: [],
      },
    });
  });

  it("searches UTF-8 files under a directory without an extension allowlist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-directory-"));
    await writeFile(path.join(root, "sources.cmake"), "target_link_libraries(foo)\n", "utf8");
    await writeFile(path.join(root, "CMakeLists.txt"), "target_link_libraries(bar)\n", "utf8");
    await writeFile(path.join(root, "schema.proto"), "target_link_libraries(proto)\n", "utf8");
    await writeFile(path.join(root, "build.gradle"), "target_link_libraries(gradle)\n", "utf8");
    await writeFile(path.join(root, "run"), "target_link_libraries(script)\n", "utf8");
    const tool = createSearchCodeTool();

    const result = await tool.execute({
      path: ".",
      query: "target_link_libraries",
      maxResults: 10,
    }, { workspaceRoot: root });

    expect(result).toMatchObject({ truncated: false });
    expect((result as { matches: unknown[] }).matches).toHaveLength(5);
    expect(result).toMatchObject({
      scan: {
        filesDiscovered: 5,
        filesSearched: 5,
        incomplete: false,
      },
    });
  });

  it("supports case folding, path globs, and nearby context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-options-"));
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, "src", "main.ts"),
      "before\nconst VALUE = 42;\nafter\n",
      "utf8",
    );
    await writeFile(path.join(root, "notes.md"), "const VALUE = 7;\n", "utf8");
    const tool = createSearchCodeTool();

    const result = await tool.execute({
      path: ".",
      query: "const value = 42;",
      maxResults: 10,
      ignoreCase: true,
      glob: "src/**/*.ts",
      context: 1,
    }, { workspaceRoot: root });

    expect(result).toMatchObject({
      matches: [{
        path: "src/main.ts",
        line: 2,
        text: "const VALUE = 42;",
        before: [{ line: 1, text: "before" }],
        after: [{ line: 3, text: "after" }],
      }],
      truncated: false,
      scan: {
        filesDiscovered: 2,
        filesSearched: 1,
        skippedByGlob: 1,
        incomplete: false,
      },
    });
  });

  it("treats empty and whitespace-only globs as no path filter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-empty-glob-"));
    await writeFile(path.join(root, "first.ts"), "shared marker\n", "utf8");
    await writeFile(path.join(root, "second.md"), "shared marker\n", "utf8");
    const tool = createSearchCodeTool();
    const parsed = tool.parse({
      path: ".",
      query: "shared marker",
      maxResults: 10,
      ignoreCase: null,
      glob: "",
      context: null,
    });

    expect(parsed).toMatchObject({ glob: null });
    const emptyResult = await tool.execute(parsed, { workspaceRoot: root }) as {
      matches: Array<{ path: string }>;
    };
    const whitespaceResult = await tool.execute({
      path: ".",
      query: "shared marker",
      maxResults: 10,
      glob: "   ",
    }, { workspaceRoot: root }) as { matches: Array<{ path: string }> };

    expect(emptyResult.matches.map((match) => match.path).sort()).toEqual([
      "first.ts",
      "second.md",
    ]);
    expect(whitespaceResult.matches).toHaveLength(2);
  });

  it("stops at the structured search-result output budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-output-budget-"));
    const noisyLine = `${"\\\"".repeat(80)} NEEDLE ${"value".repeat(30)}`;
    await writeFile(
      path.join(root, "many-matches.txt"),
      Array.from({ length: 80 }, () => noisyLine).join("\n"),
      "utf8",
    );
    const tool = createSearchCodeTool();

    const result = await tool.execute({
      path: "many-matches.txt",
      query: "NEEDLE",
      maxResults: 200,
      context: 5,
    }, { workspaceRoot: root }) as {
      matches: unknown[];
      truncated: boolean;
      scan: { incomplete: boolean; reasons: string[]; matchesFound: number };
    };

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(12_000);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThan(80);
    expect(result.truncated).toBe(true);
    expect(result.scan.incomplete).toBe(true);
    expect(result.scan.reasons).toContain("output_budget_reached");
    expect(result.scan.matchesFound).toBeGreaterThan(result.matches.length);
  });

  it("treats globstar as a complete path segment and ? as one Unicode character", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-glob-"));
    await mkdir(path.join(root, "src", "deep"), { recursive: true });
    await writeFile(path.join(root, "src", "ab.ts"), "embedded marker\n", "utf8");
    await writeFile(path.join(root, "src", "😀.ts"), "unicode marker\n", "utf8");
    await writeFile(path.join(root, "src", "deep", "nested.ts"), "nested marker\n", "utf8");
    const tool = createSearchCodeTool();

    const embeddedGlobstar = await tool.execute({
      path: ".",
      query: "embedded marker",
      maxResults: 10,
      glob: "src/a**/b.ts",
    }, { workspaceRoot: root }) as { matches: unknown[] };
    const segmentGlobstar = await tool.execute({
      path: ".",
      query: "nested marker",
      maxResults: 10,
      glob: "src/**.ts",
    }, { workspaceRoot: root }) as { matches: unknown[] };
    const unicodeQuestionMark = await tool.execute({
      path: ".",
      query: "unicode marker",
      maxResults: 10,
      glob: "src/?.ts",
    }, { workspaceRoot: root }) as { matches: Array<{ path: string }> };

    expect(embeddedGlobstar.matches).toEqual([]);
    expect(segmentGlobstar.matches).toEqual([]);
    expect(unicodeQuestionMark.matches).toEqual([{ path: "src/😀.ts", line: 1, column: 1, text: "unicode marker" }]);
  });

  it("reapplies path policy to every directory-search candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-policy-"));
    await writeFile(path.join(root, "safe.json"), "{\"marker\":\"do-not-return\"}\n", "utf8");
    await writeFile(path.join(root, "credentials.json"), "{\"marker\":\"do-not-return\"}\n", "utf8");
    const tool = createSearchCodeTool();

    const result = await tool.execute({
      path: ".",
      query: "do-not-return",
      maxResults: 10,
    }, { workspaceRoot: root });

    expect(result).toMatchObject({
      matches: [{ path: "safe.json" }],
      truncated: false,
      scan: {
        filesDiscovered: 2,
        filesSearched: 1,
        skippedByPathPolicy: 1,
        incomplete: true,
        reasons: ["path_policy"],
      },
    });
  });

  it("rejects an explicitly selected binary file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-validation-"));
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 65, 66, 67]));
    const tool = createSearchCodeTool();

    await expect(tool.execute({
      path: "binary.dat",
      query: "ABC",
      maxResults: 10,
    }, { workspaceRoot: root })).rejects.toThrow("Binary");
  });

  it("returns the match column and keeps a distant match visible on a long line", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-search-column-"));
    await writeFile(path.join(root, "long.txt"), `${"x".repeat(700)}NEEDLE${"y".repeat(300)}`, "utf8");
    const tool = createSearchCodeTool();

    const result = await tool.execute({
      path: "long.txt",
      query: "NEEDLE",
      maxResults: 10,
    }, { workspaceRoot: root }) as { matches: Array<{ column: number; text: string; lineTruncated?: boolean }> };

    expect(result.matches[0]).toMatchObject({
      column: 701,
      lineTruncated: true,
    });
    expect(result.matches[0]?.text).toContain("NEEDLE");
    expect(result.matches[0]?.text.length).toBeLessThanOrEqual(500);
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
    await writeFile(path.join(root, "credentials.json"), "{}", "utf8");

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
    expect(instructions).toContain("run_command requires host confirmation");
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
      tool.parse({ name: "review", resource: "SKILL.md" }),
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
    expect(() => tool.parse({ name: "review", resource: null })).toThrow();
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
