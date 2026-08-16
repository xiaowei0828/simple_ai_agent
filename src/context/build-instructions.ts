import process from "node:process";
import { resolveRuntimeShell, type RuntimeShell } from "../tools/process-runner.js";
import { formatDocumentCatalog, type MarkdownDocument } from "./document-catalog.js";
import type { LoadedInstructions } from "./instruction-loader.js";
import { formatSkillCatalog, type SkillMetadata } from "./skill-registry.js";

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
- Use workspace-relative paths. For an explicit path, operate directly; otherwise start with list_directory depth=1. Prefer search_code for a specific symbol or text.
- Read existing files before editing. Ask the user instead of guessing a materially ambiguous create, overwrite, or delete target.
- Prefer structured file tools. Use replace_in_file for localized edits and write_file for creation or intentional full replacement.
- Use run_command for builds, tests, version control, and uncovered commands. Write the complete command using ${shell.displayName} syntax, and check its exit code and output.
- Structured file tools are restricted to the workspace and are approved automatically. run_command requires host confirmation.
- Load a relevant skill before following its workflow.
- Keep the final response concise and mention verification that could not be run.

Runtime: ${environment.platform}/${environment.architecture}. Shell: ${shell.displayName} (${shell.executable}), non-interactive. ${platformGuidance(environment.platform)} run_command evaluates the command directly in this shell, including chaining, pipelines, redirects, variables, and other supported shell syntax.`;
}

export function buildAgentInstructions(
  projectInstructions: LoadedInstructions,
  skills: SkillMetadata[],
  documents: MarkdownDocument[] = [],
  environment: RuntimeEnvironment = detectRuntimeEnvironment(),
): string {
  const sections = [buildBaseInstructions(environment)];
  if (projectInstructions.content.trim()) {
    sections.push(`# Project instructions\n\n${projectInstructions.content}`);
  }
  if (documents.length > 0) {
    sections.push(`# Markdown documentation catalog\n\nRead a relevant document with read_file before relying on it.\n\n${formatDocumentCatalog(documents)}`);
  }
  if (skills.length > 0) {
    sections.push(`# Available skills\n\n${formatSkillCatalog(skills)}`);
  }
  return sections.join("\n\n");
}
