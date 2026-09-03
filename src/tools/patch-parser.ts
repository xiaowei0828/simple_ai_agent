import path from "node:path";
import { assertSafeRelativePath } from "../policy/path-policy.js";

export interface PatchChunk {
  anchor?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

export type FilePatch =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: PatchChunk[] };

export const MAX_PATCH_BYTES = 1_000_000;
const MAX_FILE_PATCHES = 100;

function parsePath(value: string): string {
  if (!value || value !== value.trim() || value.endsWith("/") || value.includes("\\") || path.win32.isAbsolute(value)) {
    throw new Error("Patch paths must be workspace-relative paths using forward slashes.");
  }
  assertSafeRelativePath(value);
  if (value.split("/").includes("..")) throw new Error("Patch path escapes the workspace.");
  const normalized = path.posix.normalize(value);
  if (normalized === ".") throw new Error("A patch must target a file, not the workspace root.");
  return normalized;
}

export function parsePatch(patch: string): FilePatch[] {
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    throw new Error(`Patch exceeds ${MAX_PATCH_BYTES} UTF-8 bytes.`);
  }
  if (patch.includes("\0")) throw new Error("Binary patches are not supported.");
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("Patch must start with *** Begin Patch and end with *** End Patch.");
  }

  const files: FilePatch[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const header = lines[index++]!;
    if (header.startsWith("*** Add File: ")) {
      const filePath = parsePath(header.slice("*** Add File: ".length));
      const content: string[] = [];
      while (index < lines.length - 1 && lines[index]!.startsWith("+")) {
        content.push(lines[index++]!.slice(1));
      }
      files.push({ kind: "add", path: filePath, content: content.length ? `${content.join("\n")}\n` : "" });
    } else if (header.startsWith("*** Delete File: ")) {
      files.push({ kind: "delete", path: parsePath(header.slice("*** Delete File: ".length)) });
    } else if (header.startsWith("*** Update File: ")) {
      const filePath = parsePath(header.slice("*** Update File: ".length));
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = parsePath(lines[index++]!.slice("*** Move to: ".length));
        if (moveTo === filePath) throw new Error("Move destination must differ from the source.");
      }
      const chunks: PatchChunk[] = [];
      while (index < lines.length - 1 && !lines[index]!.startsWith("*** ")) {
        const marker = lines[index++]!;
        if (marker !== "@@" && !marker.startsWith("@@ ")) {
          throw new Error(`Expected @@ before an update chunk in ${filePath}.`);
        }
        const chunk: PatchChunk = {
          ...(marker.startsWith("@@ ") ? { anchor: marker.slice(3) } : {}),
          oldLines: [], newLines: [], endOfFile: false,
        };
        let changed = false;
        while (index < lines.length - 1) {
          const line = lines[index]!;
          if (line === "*** End of File") {
            chunk.endOfFile = true;
            index += 1;
            break;
          }
          if (line === "@@" || line.startsWith("@@ ") || line.startsWith("*** ")) break;
          const prefix = line[0];
          if (prefix !== " " && prefix !== "+" && prefix !== "-") {
            throw new Error(`Update lines in ${filePath} must start with space, +, or -.`);
          }
          if (prefix !== "+") chunk.oldLines.push(line.slice(1));
          if (prefix !== "-") chunk.newLines.push(line.slice(1));
          changed ||= prefix !== " ";
          index += 1;
        }
        if (!changed) throw new Error(`Update chunk in ${filePath} contains no changes.`);
        chunks.push(chunk);
        if (chunk.endOfFile) break;
      }
      if (chunks.length === 0 && moveTo === undefined) {
        throw new Error(`Update for ${filePath} contains no changes.`);
      }
      files.push({ kind: "update", path: filePath, ...(moveTo ? { moveTo } : {}), chunks });
    } else {
      throw new Error(`Invalid patch header at line ${index}: ${header.slice(0, 120)}`);
    }
    if (files.length > MAX_FILE_PATCHES) throw new Error(`Patch exceeds ${MAX_FILE_PATCHES} file operations.`);
  }
  if (files.length === 0) throw new Error("Patch contains no file operations.");

  const targets = new Set<string>();
  for (const file of files) {
    const paths = file.kind === "update" && file.moveTo ? [file.path, file.moveTo] : [file.path];
    for (const filePath of paths) {
      const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
      for (const other of targets) {
        if (key === other || key.startsWith(`${other}/`) || other.startsWith(`${key}/`)) {
          throw new Error(`Conflicting patch targets: ${filePath}. Combine edits to one file in one Update File block.`);
        }
      }
      targets.add(key);
    }
  }
  return files;
}
