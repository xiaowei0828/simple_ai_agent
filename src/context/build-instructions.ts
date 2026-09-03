import process from "node:process";
import { resolveRuntimeShell, type RuntimeShell } from "../tools/process-runner.js";
import { formatDocumentCatalog, type MarkdownDocument } from "./document-catalog.js";
import type { LoadedInstructions } from "./instruction-loader.js";

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  architecture: string;
  shell?: RuntimeShell;
}

export function detectRuntimeEnvironment(): RuntimeEnvironment {
  return {
    platform: process.platform,
    architecture: process.arch,
    shell: resolveRuntimeShell(),
  };
}

function platformGuidance(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Use macOS/BSD command conventions; do not assume GNU-only flags.";
  if (platform === "win32") return "Use Windows PowerShell syntax; do not assume cmd.exe, Bash, or POSIX syntax. Because powershell.exe may be Windows PowerShell 5.1, avoid PowerShell 7-only operators when compatibility matters.";
  return "Use the command conventions available on this Unix-like platform; verify platform-specific flags.";
}

function buildBaseInstructions(environment: RuntimeEnvironment): string {
  const shell = environment.shell ?? resolveRuntimeShell(environment.platform);
  return `You are a code agent working in one workspace.

Rules:
- Inspect only information relevant to the task, make the smallest useful change, and verify material results. Never claim success unless tool output confirms it.
- Use workspace-relative paths for project files, and the advertised absolute paths for skills and their index. Keep run_command cwd inside the workspace even when reading an external skill. For an explicit path, operate directly. Use run_command for directory listings and searches: prefer rg for text, rg --files for file discovery, and ls (Get-ChildItem in PowerShell) for directory contents. If rg is unavailable, use the active shell's alternatives.
- For exact text, prefer rg -F; use -l when only file paths are needed and -n for matching lines. Narrow searches to the relevant repository, directory, or file as soon as it is known. Preserve default ignore rules unless the task requires ignored files. If output is truncated, narrow the search before retrying. An rg exit code of 1 means no matches; 2 means an error. Do not hide search errors or truncation with stderr suppression or head pipelines.
- Read files through run_command: use cat for small files, sed -n 'START,ENDp' for line ranges, or Get-Content with Select-Object in PowerShell. Request relevant ranges instead of dumping large files. If output is truncated, read a smaller range; do not treat partial output as a complete file.
- Batch only independent tool calls.
- Read existing files before editing. Ask the user instead of guessing a materially ambiguous create, overwrite, or delete target.
- Use apply_patch for file creation, edits, moves, and deletion. Pass patch text in the JSON patch field, wrapped in *** Begin Patch and *** End Patch. Use Add File, Update File, Delete File, and optionally Move to headers. Include enough exact context in @@ chunks to identify the intended location; re-read the file if context fails or is ambiguous.
- Use run_command for file reads, directory listings, searches, builds, tests, version control, and other commands. Write the complete command using ${shell.displayName} syntax, and check its exit code and output.
- apply_patch is restricted to workspace files and requires host approval; the default CLI policy approves it automatically. run_command requires host confirmation, including reads and searches. Its working directory is checked, but commands are not a filesystem sandbox.
- Load a relevant skill's SKILL.md through run_command before following its workflow. For long files, inspect headings and line count, then read the entry point in bounded line ranges until complete. If output is truncated, reduce the range and read the missing content before proceeding. Read referenced documents only when needed, and avoid rereading unchanged instructions already in context.
- Resolve a skill's relative references, scripts, and assets against the directory containing its SKILL.md. Quote file paths using the active shell's syntax, including spaces and special characters. Run skill scripts through run_command with host approval.
- Keep the final response concise and mention verification that could not be run.

Runtime: ${environment.platform}/${environment.architecture}. Shell: ${shell.displayName} (${shell.executable}), non-interactive. ${platformGuidance(environment.platform)} run_command evaluates the command directly in this shell, including chaining, pipelines, redirects, variables, and other supported shell syntax.`;
}

export function buildAgentInstructions(
  projectInstructions: LoadedInstructions,
  skillCatalog: string,
  documents: MarkdownDocument[] = [],
  environment: RuntimeEnvironment = detectRuntimeEnvironment(),
): string {
  const sections = [buildBaseInstructions(environment)];
  if (projectInstructions.content.trim()) {
    sections.push(`# Project instructions\n\n${projectInstructions.content}`);
  }
  if (documents.length > 0) {
    sections.push(`# Markdown documentation catalog\n\nRead a relevant document through run_command before relying on it.\n\n${formatDocumentCatalog(documents)}`);
  }
  if (skillCatalog) {
    sections.push(`# Available skills\n\n${skillCatalog}`);
  }
  return sections.join("\n\n");
}
