#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { parseCliArgs, USAGE } from "./arguments.js";
import { createConsoleEventLogger } from "./console-event-logger.js";
import { runInteractiveSession } from "./interactive-session.js";
import { openInDefaultBrowser } from "./open-default-browser.js";
import {
  loadAppConfig,
  listConfiguredModels,
  resolveAppConfigPath,
  resolveRuntimeModelConfig,
} from "../config/app-config.js";
import { AgentRunner } from "../core/agent-runner.js";
import type { ApprovalRequest } from "../core/types.js";
import { buildAgentInstructions } from "../context/build-instructions.js";
import { discoverMarkdownDocuments } from "../context/document-catalog.js";
import { loadProjectInstructions } from "../context/instruction-loader.js";
import { discoverSkills } from "../context/skill-registry.js";
import { createSkillCatalog, type SkillCatalog } from "../context/skill-catalog.js";
import { JsonlTraceLogger } from "../logging/jsonl-trace-logger.js";
import { JsonConversationStore } from "../history/conversation-store.js";
import { OpenAIModel } from "../model/openai-model.js";
import { ConfiguredModel } from "../model/configured-model.js";
import { generateTraceReport } from "../trace-viewer/generate-report.js";
import { findLatestTraceFile } from "../trace-viewer/latest-trace.js";
import {
  AutoApproveWorkspaceFileOperationsPolicy,
  CallbackApprovalPolicy,
} from "../policy/approval-policy.js";
import { createDefaultToolRegistry } from "../tools/index.js";

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const configPath = resolveAppConfigPath();
  const appConfig = await loadAppConfig(configPath);
  const runtimeConfig = resolveRuntimeModelConfig(appConfig);

  const workspaceRoot = await realpath(path.resolve(options.workspace));
  if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("--workspace must point to a directory.");
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
  const historyStore = new JsonConversationStore(path.join(workspaceRoot, ".agent-history"), {
    onWarning(message) {
      process.stderr.write(`agent: ${message}\n`);
    },
  });
  if (traceLogger) {
    process.stderr.write(`agent: raw OpenAI log: ${traceLogger.filePath}\n`);
  }

  const logEvent = createConsoleEventLogger({
    stream: options.stream,
  });
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  let readlineClosed = false;
  readline.on("close", () => {
    readlineClosed = true;
  });
  readline.on("SIGINT", () => readline.close());
  const interactiveApprovalPolicy = new CallbackApprovalPolicy(async (request: ApprovalRequest) => {
    if (options.autoApprove) return true;
    const preview = JSON.stringify(request.arguments, null, 2).slice(0, 2_000);
    const answer = await readline.question(
      `\nApprove ${request.risk} tool '${request.toolName}'?\n${preview}\n[y/N] `,
    );
    const decision = answer.trim().toLowerCase();
    return decision === "y" || decision === "yes";
  });
  const approvalPolicy = new AutoApproveWorkspaceFileOperationsPolicy(
    interactiveApprovalPolicy,
  );

  let skillCatalog: SkillCatalog | undefined;
  try {
    skillCatalog = await createSkillCatalog(skills);
    const runner = new AgentRunner({
      model: new ConfiguredModel(appConfig, (connection) => new OpenAIModel({
        apiKey: connection.apiKey,
        baseURL: connection.baseUrl,
        traceSink: traceLogger,
      })),
      modelName: runtimeConfig.selector,
      instructions: buildAgentInstructions(projectInstructions, skillCatalog.content, documents),
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot },
      approvalPolicy,
      maxSteps: options.maxSteps,
      stream: options.stream,
      onEvent: logEvent,
    });

    await runInteractiveSession({
      agent: runner,
      initialModel: runtimeConfig.selector,
      availableModels: listConfiguredModels(appConfig).map((choice) => choice.selector),
      historyStore,
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
          if (readlineClosed) return undefined;
          try {
            return await readline.question(label);
          } catch (error) {
            if (readlineClosed) return undefined;
            throw error;
          }
        },
        writeAssistant(output) {
          if (!options.stream) process.stdout.write(`assistant> ${output}\n\n`);
        },
        writeStatus(output) {
          process.stderr.write(`${output}\n`);
        },
      },
    });
  } finally {
    readline.close();
    try {
      await traceLogger?.close();
    } finally {
      await skillCatalog?.dispose();
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
