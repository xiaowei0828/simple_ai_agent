#!/usr/bin/env node

import path from "node:path";
import { generateTraceReport, replaceExtension } from "../trace-viewer/generate-report.js";

interface CliOptions {
  inputPath: string;
  outputPath: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;

  const { outputPath, report } = await generateTraceReport(
    path.resolve(options.inputPath),
    path.resolve(options.outputPath),
  );

  console.log(`Trace report: ${outputPath}`);
  console.log(
    `Summary: ${report.turns.length} requests, ${report.totals.toolCalls} tool calls, ${report.totals.errors} request errors`,
  );
  if (report.warnings.length > 0) {
    console.warn(`Warnings: ${report.warnings.length} (open the report for details)`);
  }
}

function parseArguments(args: string[]): CliOptions | undefined {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return undefined;
  }

  let inputPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output" || argument === "-o") {
      outputPath = args[index + 1];
      if (!outputPath) throw new Error(`${argument} 后需要提供 HTML 输出路径。`);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--output=")) {
      outputPath = argument.slice("--output=".length);
      continue;
    }
    if (argument?.startsWith("-")) throw new Error(`未知参数：${argument}`);
    if (inputPath) throw new Error(`只能提供一个 JSONL 日志文件，多余参数：${argument}`);
    inputPath = argument;
  }

  if (!inputPath) {
    printHelp();
    throw new Error("缺少 JSONL 日志文件路径。");
  }

  return {
    inputPath,
    outputPath: outputPath ?? replaceExtension(inputPath, ".html"),
  };
}

function printHelp(): void {
  console.log(`Usage:
  npm run trace:view -- <trace.jsonl>
  npm run trace:view -- <trace.jsonl> --output <report.html>

The report is a self-contained HTML file. It keeps raw request/response records
available in collapsed sections and writes the result with mode 0600.`);
}

main().catch((error: unknown) => {
  console.error(`Trace viewer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
