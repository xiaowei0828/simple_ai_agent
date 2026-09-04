import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplyPatchTool } from "../src/tools/apply-patch.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { createTempDirectoryFixture } from "./test-utils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const createTempDirectory = createTempDirectoryFixture();
async function fixture(): Promise<string> {
  return createTempDirectory("simple-agent-patch-");
}

afterEach(() => vi.mocked(fs.writeFile).mockReset());

function apply(root: string, body: string): Promise<unknown> {
  const tool = createApplyPatchTool();
  return tool.execute(tool.parse({ patch: `*** Begin Patch\n${body}\n*** End Patch` }), { workspaceRoot: root });
}

describe("apply_patch", () => {
  it("exposes only patch and command tools", () => {
    expect(createDefaultToolRegistry().definitions().map((tool) => tool.name))
      .toEqual(["apply_patch", "run_command"]);
  });

  it("creates nested files, edits with exact context, and deletes in one patch", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "existing.ts"), "// keep\nconst answer = 42;\n// tail\n");
    await fs.writeFile(path.join(root, "obsolete.txt"), "obsolete");
    const result = await apply(root, [
      "*** Add File: new/deep/hello.txt", "+你好", "+",
      "*** Update File: existing.ts", "@@", " // keep", "-const answer = 42;", "+const answer = 7;", " // tail",
      "*** Delete File: obsolete.txt",
    ].join("\n"));
    expect(result).toMatchObject({ changedFiles: 3, changes: [
      { path: "new/deep/hello.txt", operation: "add" },
      { path: "existing.ts", operation: "update" },
      { path: "obsolete.txt", operation: "delete" },
    ] });
    expect(await fs.readFile(path.join(root, "new/deep/hello.txt"), "utf8")).toBe("你好\n\n");
    expect(await fs.readFile(path.join(root, "existing.ts"), "utf8")).toBe("// keep\nconst answer = 7;\n// tail\n");
    await expect(fs.lstat(path.join(root, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves a file with edits and also supports a move without edits", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "old.ts"), "const answer = 42;\n");
    await apply(root, "*** Update File: old.ts\n*** Move to: src/new.ts\n@@\n-const answer = 42;\n+const answer = 7;");
    expect(await fs.readFile(path.join(root, "src/new.ts"), "utf8")).toBe("const answer = 7;\n");
    await expect(fs.lstat(path.join(root, "old.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await apply(root, "*** Update File: src/new.ts\n*** Move to: final.ts");
    expect(await fs.readFile(path.join(root, "final.ts"), "utf8")).toBe("const answer = 7;\n");
    await expect(fs.lstat(path.join(root, "src/new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses anchors and ordered chunks to distinguish repeated lines", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "file.txt"), "first\nvalue\nsecond\nvalue\ntail\n");
    await apply(root, "*** Update File: file.txt\n@@ second\n-value\n+changed\n@@\n-tail\n+end\n*** End of File");
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("first\nvalue\nsecond\nchanged\nend\n");
  });

  it("rejects ambiguous context and accepts explicit end-of-file context", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "file.txt"), "value\nvalue\n");
    await expect(apply(root, "*** Update File: file.txt\n@@\n-value\n+changed")).rejects.toThrow("Ambiguous");
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("value\nvalue\n");
    await apply(root, "*** Update File: file.txt\n@@\n-value\n+changed\n*** End of File");
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("value\nchanged\n");
  });

  it.each([
    ["first\r\nlonger\r\n", "first\r\nx\r\n"],
    ["first\nlonger", "first\nx"],
    ["\uFEFFfirst\nlonger\n", "\uFEFFfirst\nx\n"],
  ])("preserves newline style, final newline, and BOM: %j", async (original, expected) => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "file.txt"), original);
    await apply(root, "*** Update File: file.txt\n@@\n-longer\n+x");
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe(expected);
  });

  it("handles empty files, insertion-only chunks, and removal of all content", async () => {
    const root = await fixture();
    await apply(root, "*** Add File: empty.txt");
    expect(await fs.readFile(path.join(root, "empty.txt"), "utf8")).toBe("");
    await apply(root, "*** Update File: empty.txt\n@@\n+line");
    await apply(root, "*** Update File: empty.txt\n@@\n+tail");
    expect(await fs.readFile(path.join(root, "empty.txt"), "utf8")).toBe("line\ntail\n");
    await apply(root, "*** Update File: empty.txt\n@@\n-line\n-tail");
    expect(await fs.readFile(path.join(root, "empty.txt"), "utf8")).toBe("");
  });

  it("validates every operation before changing files or creating directories", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "file.txt"), "original\n");
    await expect(apply(root, [
      "*** Add File: new/first.txt", "+created",
      "*** Update File: file.txt", "@@", "-wrong context", "+replacement",
    ].join("\n"))).rejects.toThrow("Could not find patch context");
    expect(await fs.readdir(root)).toEqual(["file.txt"]);
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("original\n");
  });

  it("rejects existing add/move destinations and missing delete targets before any changes", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "file.txt"), "original\n");
    await fs.writeFile(path.join(root, "other.txt"), "other\n");
    for (const invalid of [
      "*** Add File: file.txt\n+overwrite",
      "*** Update File: file.txt\n*** Move to: other.txt",
      "*** Delete File: missing.txt",
    ]) {
      await expect(apply(root, `*** Add File: new/first.txt\n+created\n${invalid}`)).rejects.toThrow(/exists|does not exist/);
    }
    expect((await fs.readdir(root)).sort()).toEqual(["file.txt", "other.txt"]);
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("original\n");
  });

  it("rejects invalid syntax, conflicting targets, protected paths, and oversized patches", () => {
    const tool = createApplyPatchTool();
    for (const patch of [
      "", "*** Begin Patch\n*** End Patch", "*** Begin Patch\n*** Add File: file.txt\n+missing end",
      "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch",
      "*** Begin Patch\n*** Add File: /absolute.txt\n+x\n*** End Patch",
      "*** Begin Patch\n*** Add File: C:\\escape.txt\n+x\n*** End Patch",
      "*** Begin Patch\n*** Add File: .env\n+x\n*** End Patch",
      "*** Begin Patch\n*** Delete File: .git/config\n*** End Patch",
      "*** Begin Patch\n*** Update File: file.txt\n@@\nunprefixed\n*** End Patch",
      "*** Begin Patch\n*** Update File: file.txt\n@@\n context only\n*** End Patch",
      "*** Begin Patch\n*** Add File: file.txt\n+x\n*** Delete File: ./file.txt\n*** End Patch",
      "*** Begin Patch\n*** Add File: dir\n+x\n*** Add File: dir/file.txt\n+x\n*** End Patch",
      "*** Begin Patch\n*** Add File: file.txt\n+binary\0data\n*** End Patch",
      `*** Begin Patch\n*** Add File: file.txt\n+${"x".repeat(1_000_000)}\n*** End Patch`,
      `*** Begin Patch\n${Array.from({ length: 101 }, (_, index) => `*** Add File: file-${index}`).join("\n")}\n*** End Patch`,
    ]) {
      expect(() => tool.parse({ patch })).toThrow();
    }
    expect(() => tool.parse({ patch: "*** Begin Patch\n*** Add File: a\n*** End Patch", extra: true })).toThrow();
  });

  it("rejects binary, invalid UTF-8, oversized files, and directory operations", async () => {
    const root = await fixture();
    for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff]), Buffer.alloc(1_000_001, 97)]) {
      await fs.writeFile(path.join(root, "file.txt"), bytes);
      await expect(apply(root, "*** Update File: file.txt\n@@\n+x")).rejects.toThrow();
      expect(await fs.readFile(path.join(root, "file.txt"))).toEqual(bytes);
    }
    await fs.mkdir(path.join(root, "dir"));
    await expect(apply(root, "*** Delete File: dir")).rejects.toThrow("only accepts");
    await expect(apply(root, "*** Update File: dir\n@@\n+x")).rejects.toThrow("only accepts");
  });

  it("rejects parent symlink escapes even when deeper parent directories do not exist", async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(apply(root, "*** Add File: escape/new/deep/file.txt\n+x")).rejects.toThrow("escapes");
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.symlink(path.join(outside, "missing"), path.join(root, "dangling"), process.platform === "win32" ? "junction" : "dir");
    await expect(apply(root, "*** Add File: dangling/new/file.txt\n+x")).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("rejects aliases of protected directories and duplicate canonical targets", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, ".config"));
    await fs.mkdir(path.join(root, "src"));
    await fs.symlink(path.join(root, ".config"), path.join(root, "settings"), process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(path.join(root, "src"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(apply(root, "*** Add File: settings/new/file.txt\n+x")).rejects.toThrow("blocked");
    await expect(apply(root, "*** Add File: src/new.txt\n+x\n*** Add File: alias/new.txt\n+y")).rejects.toThrow("alias");
    expect(await fs.readdir(path.join(root, "src"))).toEqual([]);
  });

  it("does not overwrite a symlink and deletes only the link", async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.writeFile(path.join(outside, "target.txt"), "untouched\n");
    await fs.symlink(path.join(outside, "target.txt"), path.join(root, "link.txt"), "file");
    await expect(apply(root, "*** Add File: link.txt\n+x")).rejects.toThrow("exists");
    await expect(apply(root, "*** Update File: link.txt\n@@\n-untouched\n+x")).rejects.toThrow("symbolic links");
    await apply(root, "*** Delete File: link.txt");
    expect(await fs.readFile(path.join(outside, "target.txt"), "utf8")).toBe("untouched\n");
    await expect(fs.lstat(path.join(root, "link.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports partial changes when writing fails after preflight", async () => {
    const root = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.writeFile)
      .mockImplementationOnce(actual.writeFile)
      .mockRejectedValueOnce(new Error("simulated disk failure"));
    await expect(apply(root, "*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second"))
      .rejects.toThrow(/simulated disk failure.*Completed operations: first.txt.*first.txt, second.txt/);
    expect(await fs.readFile(path.join(root, "first.txt"), "utf8")).toBe("first\n");
    await expect(fs.lstat(path.join(root, "second.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
