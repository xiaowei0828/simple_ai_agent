import process from "node:process";
import { resolveRuntimeShell, type RuntimeShell } from "../tools/process-runner.js";
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
- Follow the user's request. Inspect relevant files, make the smallest useful change, and verify results before claiming success.
- Prefer working inside the workspace. External file changes require host approval unless --yes is set. Read files before editing, and ask before ambiguous destructive changes.
- Use run_command for inspection, builds, and tests; use apply_patch for file changes. Respect tool approval requirements.
- Prefer rg and rg --files for search. Keep searches and file reads focused, and narrow them if output is truncated.
- Follow the workspace root AGENTS.md. User instructions take precedence over AGENTS.md, and AGENTS.md takes precedence over skill guidance.
- When a task matches a skill, read its SKILL.md before acting and resolve relative references from the skill directory.
- Keep final responses concise. Report changes, verification, and checks that could not run.

Runtime: ${environment.platform}/${environment.architecture}. Shell: ${shell.displayName} (${shell.executable}), non-interactive. ${platformGuidance(environment.platform)}`;
}

export function buildAgentInstructions(
  projectInstructions: LoadedInstructions,
  skillCatalog: string,
  environment: RuntimeEnvironment = detectRuntimeEnvironment(),
): string {
  const sections = [buildBaseInstructions(environment)];
  if (projectInstructions.content.trim()) {
    sections.push(`# Project instructions\n\n${projectInstructions.content}`);
  }
  if (skillCatalog) {
    sections.push(`# Available skills\n\n${skillCatalog}`);
  }
  return sections.join("\n\n");
}
