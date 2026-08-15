import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function findLatestTraceFile(directory: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }

  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".jsonl")
    .map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      try {
        return { filePath, modifiedAt: (await stat(filePath)).mtimeMs };
      } catch {
        return undefined;
      }
    }));

  return candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
    ?.filePath;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
