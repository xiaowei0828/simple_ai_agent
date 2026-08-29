import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReadFileTool } from "../src/tools/read-file.js";

describe("read_file pagination", () => {
  it("reads a small requested range from a file larger than one megabyte", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-large-read-"));
    await writeFile(path.join(root, "large.txt"), `${"padding\n".repeat(140_000)}tail\n`, "utf8");
    const tool = createReadFileTool();

    await expect(tool.execute({
      path: "large.txt",
      lineStart: 2,
      lineEnd: 3,
    }, { workspaceRoot: root })).resolves.toMatchObject({
      lineStart: 2,
      lineEnd: 3,
      content: "padding\npadding",
      truncated: false,
      nextLine: null,
    });
  });

  it("returns an actionable continuation line when a full-file read reaches its line budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-read-cursor-"));
    const content = Array.from({ length: 550 }, (_, index) => `line ${index + 1}`).join("\n");
    await writeFile(path.join(root, "many-lines.txt"), content, "utf8");
    const tool = createReadFileTool();

    const first = await tool.execute({
      path: "many-lines.txt",
      lineStart: null,
      lineEnd: null,
    }, { workspaceRoot: root });

    expect(first).toMatchObject({
      lineStart: 1,
      lineEnd: 500,
      truncated: true,
      nextLine: 501,
      truncatedBy: "line_limit",
    });

    await expect(tool.execute({
      path: "many-lines.txt",
      lineStart: 501,
      lineEnd: null,
    }, { workspaceRoot: root })).resolves.toMatchObject({
      lineStart: 501,
      lineEnd: 550,
      truncated: false,
      nextLine: null,
    });
  });

  it("reports the actual final line when the requested start is beyond end of file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-read-eof-"));
    await writeFile(path.join(root, "short.txt"), "one\ntwo", "utf8");
    const tool = createReadFileTool();

    await expect(tool.execute({
      path: "short.txt",
      lineStart: 10,
      lineEnd: null,
    }, { workspaceRoot: root })).resolves.toMatchObject({
      lineStart: 10,
      lineEnd: 2,
      content: "",
      truncated: false,
      nextLine: null,
    });
  });

  it("distinguishes a long single line from a multi-line character limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-read-character-limits-"));
    await writeFile(path.join(root, "long-line.txt"), `${"x".repeat(30_100)}\nafter`, "utf8");
    await writeFile(
      path.join(root, "long-range.txt"),
      `${"a".repeat(20_000)}\n${"b".repeat(20_000)}\nend`,
      "utf8",
    );
    const tool = createReadFileTool();

    await expect(tool.execute({
      path: "long-line.txt",
      lineStart: null,
      lineEnd: null,
    }, { workspaceRoot: root })).resolves.toMatchObject({
      lineEnd: 1,
      truncated: true,
      nextLine: 2,
      truncatedBy: "line_too_long",
    });
    await expect(tool.execute({
      path: "long-range.txt",
      lineStart: null,
      lineEnd: null,
    }, { workspaceRoot: root })).resolves.toMatchObject({
      lineEnd: 1,
      truncated: true,
      nextLine: 2,
      truncatedBy: "character_limit",
    });
  });

  it("rejects NUL-containing binary input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-read-binary-"));
    await writeFile(path.join(root, "binary.txt"), Buffer.from([65, 0, 66]));
    const tool = createReadFileTool();

    await expect(tool.execute({
      path: "binary.txt",
      lineStart: null,
      lineEnd: null,
    }, { workspaceRoot: root })).rejects.toThrow("Binary");
  });
});
