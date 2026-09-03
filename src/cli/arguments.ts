import process from "node:process";
import { DEFAULT_MAX_STEPS } from "../core/agent-runner.js";

export interface CliOptions {
  workspace: string;
  maxSteps: number;
  skillRoots: string[];
  autoApprove: boolean;
  stream: boolean;
  debug: boolean;
  help: boolean;
}

export const USAGE = `simple-code-agent [options]

Starts an interactive session with streaming enabled. Enter tasks at the agent> prompt.

Options:
  -w, --workspace <path>    Workspace root (default: current directory)
      --max-steps <number>  Maximum model turns (default: ${DEFAULT_MAX_STEPS})
      --skill-root <path>   Additional directory containing <skill>/SKILL.md
      --stream              Stream model output (default)
      --no-stream           Wait for complete model responses
      --debug               Add raw requests, responses, and SSE events to the session log
  -y, --yes                 Approve run_command calls without prompting
  -h, --help                Show this help

Environment:
  CODE_AGENT_SKILL_ROOTS         Extra skill roots separated by the OS path delimiter

Configuration:
  .config/config.json            Array of API connections, each with apiKey, baseUrl, and models

Examples:
  npm run dev -- --workspace .
  npm run dev -- --workspace /path/to/project --debug`;

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    workspace: process.cwd(),
    maxSteps: DEFAULT_MAX_STEPS,
    skillRoots: [],
    autoApprove: false,
    stream: true,
    debug: false,
    help: false,
  };
  const taskError = "Startup task input is not supported. Start the agent, then enter your task at the agent> prompt.";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      if (index + 1 < argv.length) throw new Error(taskError);
      break;
    }
    if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (argument === "--stream") {
      options.stream = true;
    } else if (argument === "--no-stream") {
      options.stream = false;
    } else if (argument === "--debug") {
      options.debug = true;
    } else if (argument === "-y" || argument === "--yes") {
      options.autoApprove = true;
    } else if (argument === "-w" || argument === "--workspace") {
      options.workspace = requireValue(argv, ++index, argument);
    } else if (argument === "--max-steps") {
      const value = Number(requireValue(argv, ++index, argument));
      if (!Number.isInteger(value) || value < 1 || value > DEFAULT_MAX_STEPS) {
        throw new Error(`--max-steps must be an integer between 1 and ${DEFAULT_MAX_STEPS}.`);
      }
      options.maxSteps = value;
    } else if (argument === "--skill-root") {
      options.skillRoots.push(requireValue(argv, ++index, argument));
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      throw new Error(taskError);
    }
  }

  return options;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return value;
}
