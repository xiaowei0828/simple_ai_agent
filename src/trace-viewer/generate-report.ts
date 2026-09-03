import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseOpenAITraceJsonl } from "./parse-trace.js";
import { renderTraceReportHtml } from "./render-html.js";
import type { TraceReport } from "./types.js";

export interface GeneratedTraceReport {
  inputPath: string;
  outputPath: string;
  report: TraceReport;
}

export async function generateTraceReport(
  inputFile: string,
  outputFile: string = replaceExtension(inputFile, ".html"),
): Promise<GeneratedTraceReport> {
  const inputPath = path.resolve(inputFile);
  const outputPath = path.resolve(outputFile);
  if (inputPath === outputPath) {
    throw new Error("输出路径不能与原始 JSONL 日志相同。");
  }

  const jsonl = await readFile(inputPath, "utf8");
  const sourceName = path.relative(process.cwd(), inputPath) || path.basename(inputPath);
  const report = parseOpenAITraceJsonl(jsonl, sourceName);
  const html = renderTraceReportHtml(report);

  await writeFile(outputPath, html, { encoding: "utf8", mode: 0o600 });
  await chmod(outputPath, 0o600);
  return { inputPath, outputPath, report };
}

function replaceExtension(filePath: string, extension: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}
