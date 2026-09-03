import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createWorkspacePathResolver, type WorkspacePathResolver } from "../policy/path-policy.js";
import { applyChunks } from "./patch-content.js";
import { MAX_PATCH_BYTES, parsePatch, type FilePatch } from "./patch-parser.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({ patch: z.string().min(1) }).strict();

interface PreparedChange {
  patch: FilePatch;
  source: string;
  destination: string;
  before?: Stats;
  content?: string;
}

async function statIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

// Resolve parent aliases, but not the last component: deleting a symlink must
// delete the link itself, never the file it points to.
async function canonicalTarget(filePath: string): Promise<string> {
  let parent = path.dirname(filePath);
  const missing = [path.basename(filePath)];
  while (true) {
    if (await statIfExists(parent)) {
      return path.join(await realpath(parent), ...missing);
    }
    missing.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error("No existing parent for patch target.");
    parent = next;
  }
}

async function prepareChanges(
  patches: FilePatch[], resolver: WorkspacePathResolver,
): Promise<PreparedChange[]> {
  const changes: PreparedChange[] = [];
  const targets = new Set<string>();
  for (const patch of patches) {
    const source = await resolver.resolveForMutation(patch.path);
    const destination = patch.kind === "update" && patch.moveTo
      ? await resolver.resolveForMutation(patch.moveTo) : source;
    for (const target of new Set([source, destination])) {
      const canonical = await canonicalTarget(target);
      const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
      for (const other of targets) {
        if (key === other || key.startsWith(`${other}${path.sep}`) || other.startsWith(`${key}${path.sep}`)) {
          throw new Error(`Conflicting patch targets through a path alias: ${patch.path}.`);
        }
      }
      targets.add(key);
    }

    const before = await statIfExists(source);
    let content: string | undefined;
    if (patch.kind === "add") {
      if (before) throw new Error(`File already exists: ${patch.path}. Use Update File.`);
      content = patch.content;
    } else {
      if (!before) throw new Error(`File does not exist: ${patch.path}.`);
      if (patch.kind === "delete") {
        if (!before.isFile() && !before.isSymbolicLink()) {
          throw new Error(`Delete File only accepts files or symbolic links: ${patch.path}.`);
        }
      } else {
        if (!before.isFile() || before.isSymbolicLink()) {
          throw new Error(`Update File only accepts regular files, not symbolic links: ${patch.path}.`);
        }
        if (before.size > MAX_PATCH_BYTES) throw new Error(`File exceeds ${MAX_PATCH_BYTES} bytes: ${patch.path}.`);
        const bytes = await readFile(source);
        if (bytes.includes(0)) throw new Error(`Binary files cannot be updated: ${patch.path}.`);
        const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        content = applyChunks(original, patch.chunks, patch.path);
        if (Buffer.byteLength(content, "utf8") > MAX_PATCH_BYTES) {
          throw new Error(`Updated file exceeds ${MAX_PATCH_BYTES} UTF-8 bytes: ${patch.path}.`);
        }
        if (destination !== source && await statIfExists(destination)) {
          throw new Error(`Move destination already exists: ${patch.moveTo}.`);
        }
      }
    }
    changes.push({ patch, source, destination, before, content });
  }
  return changes;
}

function checkSnapshot(change: PreparedChange, current: Stats | undefined): void {
  const before = change.before;
  if (before === undefined ? current !== undefined : (
    current === undefined || current.dev !== before.dev || current.ino !== before.ino ||
    current.size !== before.size || current.mtimeMs !== before.mtimeMs ||
    current.ctimeMs !== before.ctimeMs || current.mode !== before.mode
  )) {
    throw new Error(`File changed while preparing the patch: ${change.patch.path}. Read it and retry.`);
  }
}

async function assertUnchanged(change: PreparedChange): Promise<void> {
  checkSnapshot(change, await statIfExists(change.source));
}

async function writeUpdatedFile(change: PreparedChange): Promise<void> {
  const handle = await open(change.source, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    checkSnapshot(change, await handle.stat());
    await handle.writeFile(change.content!, "utf8");
    await handle.truncate(Buffer.byteLength(change.content!, "utf8"));
  } finally {
    await handle.close();
  }
}

export function createApplyPatchTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "write",
    definition: {
      type: "function",
      name: "apply_patch",
      description: "Create, edit, move, or delete workspace files with a patch. Read existing files using run_command first. Wrap the patch in *** Begin Patch and *** End Patch. Use *** Add File: path with + lines; *** Delete File: path; or *** Update File: path with @@ chunks (space=context, -=remove, +=add). An update may include *** Move to: path before its chunks. @@ text anchors a chunk after an exact line; *** End of File requires a chunk to match the file end. Context must match exactly and unambiguously. Paths use workspace-relative forward slashes. New parent directories are created. Existing add/move destinations, binary updates, and conflicting targets are rejected. All changes are validated before writing; I/O failures may still leave partial changes. Requires host approval.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Patch text, at most 1,000,000 UTF-8 bytes and 100 file operations. Example: *** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch" },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
    parse(input) {
      const parsed = inputSchema.parse(input);
      parsePatch(parsed.patch);
      return parsed;
    },
    async execute(input, context) {
      const resolver = await createWorkspacePathResolver(context.workspaceRoot);
      const changes = await prepareChanges(parsePatch(input.patch), resolver);
      const attempted: string[] = [];
      const completed: string[] = [];
      try {
        for (const change of changes) {
          const { patch, source, destination, content, before } = change;
          await resolver.resolveForMutation(patch.path);
          await assertUnchanged(change);
          const outputPath = patch.kind === "update" && patch.moveTo ? patch.moveTo : patch.path;
          await resolver.resolveForMutation(outputPath);
          attempted.push(outputPath);
          if (patch.kind === "delete") {
            await unlink(source);
          } else if (patch.kind === "add" || destination !== source) {
            await mkdir(path.dirname(destination), { recursive: true });
            await resolver.resolveForMutation(outputPath);
            await writeFile(destination, content!, { encoding: "utf8", flag: "wx", mode: before?.mode });
            if (destination !== source) {
              attempted.push(patch.path);
              await resolver.resolveForMutation(patch.path);
              await assertUnchanged(change);
              await unlink(source);
            }
          } else {
            await writeUpdatedFile(change);
          }
          completed.push(patch.path);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${reason} Completed operations: ${completed.join(", ") || "none"}. Paths that may have changed (including parent directories): ${attempted.join(", ") || "none"}.`);
      }
      return {
        changedFiles: changes.length,
        changes: changes.map(({ patch, content }) => ({
          path: patch.path,
          operation: patch.kind === "update" && patch.moveTo ? "move" : patch.kind,
          ...(patch.kind === "update" && patch.moveTo ? { moveTo: patch.moveTo } : {}),
          ...(content !== undefined ? { bytesWritten: Buffer.byteLength(content, "utf8") } : {}),
        })),
      };
    },
  };
}
