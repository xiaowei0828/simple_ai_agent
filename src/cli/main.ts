#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { runInteractiveSession } from "./interactive-session.js";
import { openInDefaultBrowser } from "./open-default-browser.js";
import {
  CommandAllowlistStore,
  resolveCommandAllowlistPath,
} from "../config/command-allowlist.js";
import {
  loadAppConfig,
  resolveAppConfigPath,
  resolveRuntimeModelConfig,
} from "../config/app-config.js";
import { AgentRunner, DEFAULT_MAX_STEPS } from "../core/agent-runner.js";
import type { AgentEvent, ApprovalRequest } from "../core/types.js";
import { buildAgentInstructions } from "../context/build-instructions.js";
import { discoverMarkdownDocuments } from "../context/document-catalog.js";
import { loadProjectInstructions } from "../context/instruction-loader.js";
import { discoverSkills } from "../context/skill-registry.js";
import { JsonlTraceLogger } from "../logging/jsonl-trace-logger.js";
import { OpenAIModel } from "../model/openai-model.js";
import { generateTraceReport } from "../trace-viewer/generate-report.js";
import { findLatestTraceFile } from "../trace-viewer/latest-trace.js";
import {
  AutoApproveWorkspaceFileOperationsPolicy,
  CallbackApprovalPolicy,
  extractSimpleCommandPrograms,
  ProgramAllowlistApprovalPolicy,
} from "../policy/approval-policy.js";
import { createDefaultToolRegistry } from "../tools/index.js";

interface CliOptions {
  workspace: string;
  model?: string;
  maxSteps: number;
  skillRoots: string[];
  autoApprove: boolean;
  interactive: boolean;
  debug: boolean;
  help: boolean;
  task: string;
}

const USAGE = `simple-code-agent [options] [task]

Options:
  -w, --workspace <path>    Workspace root (default: current directory)
  -m, --model <name>        Override the model configured in .config/config.json
      --max-steps <number>  Maximum model turns (default: ${DEFAULT_MAX_STEPS})
      --skill-root <path>   Additional directory containing <skill>/SKILL.md
      --debug               Write raw OpenAI request/response JSONL logs
  -i, --interactive         Continue interactively after an optional initial task
  -y, --yes                 Approve run_command calls without prompting
  -h, --help                Show this help

Environment:
  OPENAI_API_KEY                 Override the configured API key
  OPENAI_BASE_URL                Override the configured compatible API base URL
  CODE_AGENT_SKILL_ROOTS         Extra skill roots separated by the OS path delimiter

Configuration:
  .config/config.json            API key, base URL, default model, and available models
  .config/command-allowlist.json Programs persistently approved for direct run_command calls

Examples:
  npm run dev -- --workspace .
  npm run dev -- --workspace . "inspect the project and fix the failing tests"
  npm run dev -- --interactive "first inspect the project"`;

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    workspace: process.cwd(),
    maxSteps: DEFAULT_MAX_STEPS,
    skillRoots: [],
    autoApprove: false,
    interactive: false,
    debug: false,
    help: false,
    task: "",
  };
  const taskParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      taskParts.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (argument === "--debug") {
      options.debug = true;
    } else if (argument === "-i" || argument === "--interactive") {
      options.interactive = true;
    } else if (argument === "-y" || argument === "--yes") {
      options.autoApprove = true;
    } else if (argument === "-w" || argument === "--workspace") {
      options.workspace = requireValue(argv, ++index, argument);
    } else if (argument === "-m" || argument === "--model") {
      options.model = requireValue(argv, ++index, argument);
    } else if (argument === "--max-steps") {
      const value = Number(requireValue(argv, ++index, argument));
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--max-steps must be an integer between 1 and 100.");
      }
      options.maxSteps = value;
    } else if (argument === "--skill-root") {
      options.skillRoots.push(requireValue(argv, ++index, argument));
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument) {
      taskParts.push(argument);
    }
  }

  options.task = taskParts.join(" ").trim();
  return options;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function logEvent(event: AgentEvent): void {
  switch (event.type) {
    case "run_started":
      process.stderr.write(`agent: started\n`);
      break;
    case "model_response":
      process.stderr.write(`agent: model turn ${event.step}, ${event.response.toolCalls.length} tool call(s)\n`);
      break;
    case "tool_requested":
      process.stderr.write(`agent: requesting ${event.call.name}${event.risk ? ` [${event.risk}]` : ""}\n`);
      break;
    case "tool_completed":
      process.stderr.write(`agent: ${event.toolName} completed\n`);
      break;
    case "tool_failed":
      process.stderr.write(`agent: ${event.toolName} failed: ${event.error}\n`);
      break;
    default:
      break;
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const configPath = resolveAppConfigPath();
  const appConfig = await loadAppConfig(configPath);
  const runtimeConfig = resolveRuntimeModelConfig(appConfig, {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    model: options.model,
  });
  if (!runtimeConfig.apiKey) {
    throw new Error(`API key is not configured. Set apiKey in '${configPath}' or OPENAI_API_KEY.`);
  }

  const workspaceRoot = await realpath(path.resolve(options.workspace));
  if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("--workspace must point to a directory.");
  const commandAllowlistPath = resolveCommandAllowlistPath();
  const commandAllowlist = await CommandAllowlistStore.load(commandAllowlistPath);

  const environmentRoots = (process.env.CODE_AGENT_SKILL_ROOTS ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const skillRoots = [
    path.join(workspaceRoot, ".agents", "skills"),
    path.join(homedir(), ".agents", "skills"),
    ...environmentRoots,
    ...options.skillRoots,
  ].map((root) => path.resolve(root));

  const [projectInstructions, skills, documents] = await Promise.all([
    loadProjectInstructions(workspaceRoot),
    discoverSkills([...new Set(skillRoots)]),
    discoverMarkdownDocuments(workspaceRoot),
  ]);
  process.stderr.write(
    `agent: loaded ${projectInstructions.files.length} instruction file(s), indexed ${documents.length} doc(s), discovered ${skills.length} skill(s)\n`,
  );

  const traceLogger = options.debug
    ? await JsonlTraceLogger.create(path.join(workspaceRoot, ".agent-runs"))
    : undefined;
  const traceDirectory = path.join(workspaceRoot, ".agent-runs");
  if (traceLogger) {
    process.stderr.write(`agent: raw OpenAI log: ${traceLogger.filePath}\n`);
  }

  const interactiveMode = options.interactive || !options.task;
  const readline = interactiveMode || !options.autoApprove
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  let readlineClosed = false;
  readline?.on("close", () => {
    readlineClosed = true;
  });
  readline?.on("SIGINT", () => readline.close());
  const interactiveApprovalPolicy = new CallbackApprovalPolicy(async (request: ApprovalRequest) => {
    if (options.autoApprove) return true;
    const preview = JSON.stringify(request.arguments, null, 2).slice(0, 2_000);
    const command = request.toolName === "run_command"
      && typeof request.arguments === "object"
      && request.arguments !== null
      && "command" in request.arguments
      && typeof request.arguments.command === "string"
      ? request.arguments.command
      : undefined;
    const programs = command ? extractSimpleCommandPrograms(command) : undefined;
    const programLabel = programs?.join("', '");
    const choices = programs
      ? `[y] allow once  [p] always allow program(s) '${programLabel}'  [N] deny`
      : "[y/N]";
    const answer = await readline!.question(
      `\nApprove ${request.risk} tool '${request.toolName}'?\n${preview}\n${choices} `,
    );
    const decision = answer.trim().toLowerCase();
    if (decision === "y" || decision === "yes") return true;
    if (programs && (decision === "p" || decision === "program")) {
      const added = await commandAllowlist.addPrograms(programs);
      process.stderr.write(
        added.length > 0
          ? `agent: added program(s) '${added.join("', '")}' to ${commandAllowlistPath}\n`
          : "agent: all programs are already allowlisted\n",
      );
      return true;
    }
    return false;
  });
  const approvalPolicy = new AutoApproveWorkspaceFileOperationsPolicy(
    new ProgramAllowlistApprovalPolicy(commandAllowlist, interactiveApprovalPolicy),
  );

  try {
    const runner = new AgentRunner({
      model: new OpenAIModel({
        apiKey: runtimeConfig.apiKey,
        baseURL: runtimeConfig.baseUrl,
        traceSink: traceLogger,
      }),
      modelName: runtimeConfig.model,
      instructions: buildAgentInstructions(projectInstructions, skills, documents),
      tools: createDefaultToolRegistry(skills),
      toolContext: { workspaceRoot },
      approvalPolicy,
      maxSteps: options.maxSteps,
      onEvent: logEvent,
    });

    if (interactiveMode) {
      await runInteractiveSession({
        agent: runner,
        initialTask: options.task || undefined,
        initialModel: runtimeConfig.model,
        availableModels: appConfig.models.available,
        async viewLatestTrace() {
          await traceLogger?.flush();
          const tracePath = traceLogger?.filePath ?? await findLatestTraceFile(traceDirectory);
          if (!tracePath) {
            throw new Error("No trace log found. Start the agent with --debug to record interactions.");
          }
          const generated = await generateTraceReport(tracePath);
          await openInDefaultBrowser(generated.outputPath);
          return generated.outputPath;
        },
        io: {
          async prompt(label) {
            if (!readline || readlineClosed) return undefined;
            try {
              return await readline.question(label);
            } catch (error) {
              if (readlineClosed) return undefined;
              throw error;
            }
          },
          writeAssistant(output) {
            process.stdout.write(`assistant> ${output}\n\n`);
          },
          writeStatus(output) {
            process.stderr.write(`${output}\n`);
          },
        },
      });
    } else {
      const result = await runner.run(options.task);
      process.stdout.write(`${result.output}\n`);
    }
  } finally {
    readline?.close();
    await traceLogger?.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
