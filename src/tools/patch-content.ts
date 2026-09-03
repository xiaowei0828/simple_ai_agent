import type { PatchChunk } from "./patch-parser.js";

function findUniqueLines(
  lines: string[], pattern: string[], start: number, endOfFile: boolean, filePath: string,
): number {
  let found = -1;
  for (let index = start; index <= lines.length - pattern.length; index += 1) {
    if (endOfFile && index + pattern.length !== lines.length) continue;
    if (!pattern.every((line, offset) => lines[index + offset] === line)) continue;
    if (found !== -1) throw new Error(`Ambiguous context in ${filePath}. Include more surrounding lines or an @@ anchor.`);
    found = index;
  }
  if (found === -1) throw new Error(`Could not find patch context in ${filePath}. Read the current file and retry.`);
  return found;
}

export function applyChunks(content: string, chunks: PatchChunk[], filePath: string): string {
  if (chunks.length === 0) return content;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = content.endsWith("\n");
  const lines = content === "" ? [] : content.replace(/\r\n/g, "\n").split("\n");
  if (finalNewline) lines.pop();
  const result: string[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    let start = cursor;
    if (chunk.anchor !== undefined) {
      start = findUniqueLines(lines, [chunk.anchor], cursor, false, filePath) + 1;
    }
    const index = chunk.oldLines.length === 0
      ? (chunk.anchor === undefined ? lines.length : start)
      : findUniqueLines(lines, chunk.oldLines, start, chunk.endOfFile, filePath);
    if (chunk.endOfFile && index + chunk.oldLines.length !== lines.length) {
      throw new Error(`End-of-file chunk in ${filePath} does not match the end of the file.`);
    }
    for (let line = cursor; line < index; line += 1) result.push(lines[line]!);
    for (const line of chunk.newLines) result.push(line);
    cursor = index + chunk.oldLines.length;
  }
  for (let line = cursor; line < lines.length; line += 1) result.push(lines[line]!);
  return result.join(newline) + (result.length > 0 && (finalNewline || content === "") ? newline : "");
}
