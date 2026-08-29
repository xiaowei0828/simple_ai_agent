import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { resolveExistingWorkspacePath } from "../policy/path-policy.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  path: z.string().min(1),
  lineStart: z.number().int().positive().nullable().default(null),
  lineEnd: z.number().int().positive().nullable().default(null),
}).strict();

const MAX_RESULT_CHARS = 30_000;
const MAX_RESULT_LINES = 500;

export function createReadFileTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "read",
    executionMode: "parallel",
    definition: {
      type: "function",
      name: "read_file",
      description:
        "Read a UTF-8 text file, optionally selecting an inclusive one-based line range. Results are limited to 500 lines and 30000 characters; when more complete lines remain, nextLine identifies where to continue.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
          lineStart: { type: ["integer", "null"], minimum: 1 },
          lineEnd: { type: ["integer", "null"], minimum: 1 },
        },
        required: ["path", "lineStart", "lineEnd"],
        additionalProperties: false,
      },
    },
    parse: (input) => {
      const parsed = inputSchema.parse(input);
      if (parsed.lineStart !== null && parsed.lineEnd !== null && parsed.lineEnd < parsed.lineStart) {
        throw new Error("lineEnd must be greater than or equal to lineStart.");
      }
      return parsed;
    },
    async execute(input, context) {
      const filePath = await resolveExistingWorkspacePath(context.workspaceRoot, input.path);
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new Error("read_file only accepts files.");
      const start = input.lineStart ?? 1;
      const result = await readLineRange(filePath, start, input.lineEnd);
      return {
        path: input.path,
        lineStart: start,
        lineEnd: result.lineEnd,
        content: result.content,
        truncated: result.truncated,
        nextLine: result.nextLine,
        truncatedBy: result.truncatedBy,
      };
    },
  };
}

type ReadTruncationReason = "character_limit" | "line_limit" | "line_too_long";

interface ReadLineRangeResult {
  content: string;
  lineEnd: number;
  truncated: boolean;
  nextLine: number | null;
  truncatedBy: ReadTruncationReason | null;
}

async function readLineRange(
  filePath: string,
  lineStart: number,
  requestedLineEnd: number | null,
): Promise<ReadLineRangeResult> {
  const selectedLines: string[] = [];
  const lineEnd = requestedLineEnd ?? Number.POSITIVE_INFINITY;
  let pending = "";
  let currentLine = 1;
  let lastObservedLine = 0;
  let selectedCharacters = 0;
  let lastSelectedLine = lineStart - 1;
  let nextLine: number | null = null;
  let truncatedBy: ReadTruncationReason | null = null;
  let stopped = false;

  const stream = createReadStream(filePath, { encoding: "utf8" });

  function selectLine(line: string): boolean {
    const lineNumber = currentLine;
    currentLine += 1;
    lastObservedLine = lineNumber;

    if (lineNumber < lineStart) return true;
    if (lineNumber > lineEnd) return false;

    if (selectedLines.length >= MAX_RESULT_LINES) {
      nextLine = lineNumber;
      truncatedBy = "line_limit";
      return false;
    }

    const separatorCharacters = selectedLines.length === 0 ? 0 : 1;
    const nextLength = selectedCharacters + separatorCharacters + line.length;
    if (nextLength > MAX_RESULT_CHARS) {
      if (selectedLines.length === 0) {
        selectedLines.push(line.slice(0, MAX_RESULT_CHARS));
        selectedCharacters = MAX_RESULT_CHARS;
        lastSelectedLine = lineNumber;
        nextLine = lineNumber + 1;
        truncatedBy = "line_too_long";
      } else {
        nextLine = lineNumber;
        truncatedBy = "character_limit";
      }
      return false;
    }

    selectedLines.push(line);
    selectedCharacters = nextLength;
    lastSelectedLine = lineNumber;
    return lineNumber < lineEnd;
  }

  try {
    outer: for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.includes("\0")) throw new Error("Binary files are not supported.");
      pending += text;

      while (true) {
        const newline = pending.indexOf("\n");
        if (newline === -1) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!selectLine(line)) {
          stopped = true;
          break outer;
        }
      }

      // A generated file can contain a very large line. Avoid retaining that
      // entire line merely to reach a later requested line or discover that the
      // selected output exceeds its character budget.
      if (pending.length > MAX_RESULT_CHARS) {
        if (currentLine < lineStart) {
          pending = "";
        } else if (!selectLine(pending)) {
          stopped = true;
          break;
        }
      }
    }

    if (!stopped) {
      selectLine(pending);
    }
  } finally {
    stream.destroy();
  }

  return {
    content: selectedLines.join("\n"),
    lineEnd: lastSelectedLine >= lineStart ? lastSelectedLine : lastObservedLine,
    truncated: truncatedBy !== null,
    nextLine,
    truncatedBy,
  };
}
