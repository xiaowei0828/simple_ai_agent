import type {
  TraceReport,
  TraceToolCall,
  TraceToolDefinition,
  TraceToolResult,
  TraceTurn,
} from "./types.js";

export function renderTraceReportHtml(report: TraceReport): string {
  const title = `Agent Trace · ${report.sourceName}`;
  const requestModel = report.requestModels.join(", ") || "未知";
  const responseModel = report.responseModels.join(", ") || "未知";
  const firstTask = report.turns.flatMap((turn) => turn.userInputs)[0];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div class="eyebrow">CODE AGENT TRACE</div>
      <h1>模型交互流程</h1>
      <p class="task">${firstTask ? escapeHtml(firstTask) : "这份日志没有可识别的用户输入。"}</p>
      <div class="source" title="${escapeHtml(report.sourceName)}">${escapeHtml(report.sourceName)}</div>
    </header>

    ${renderSummary(report)}
    ${renderConfiguration(report, requestModel, responseModel)}
    ${renderWarnings(report.warnings)}

    <section class="flow-section" aria-labelledby="flow-title">
      <div class="section-heading sticky-tools">
        <div>
          <div class="eyebrow">NORMALIZED TIMELINE</div>
          <h2 id="flow-title">交互时间线</h2>
        </div>
        <div class="toolbar" aria-label="时间线筛选">
          <input id="trace-search" type="search" placeholder="搜索步骤、工具或内容" aria-label="搜索时间线">
          <button class="filter active" type="button" data-filter="all">全部</button>
          <button class="filter" type="button" data-filter="tools">工具轮次</button>
          <button class="filter" type="button" data-filter="errors">异常</button>
        </div>
      </div>
      <div class="timeline" id="timeline">
        ${report.turns.map(renderTurn).join("\n") || renderEmptyState()}
      </div>
    </section>
  </main>
  <script>${SCRIPT}</script>
</body>
</html>`;
}

function renderSummary(report: TraceReport): string {
  const cacheRatio =
    report.totals.inputTokens > 0
      ? `${Math.round((report.totals.cachedTokens / report.totals.inputTokens) * 100)}%`
      : "—";
  const metrics: Array<[string, string, string]> = [
    ["模型请求", formatNumber(report.turns.length), "轮"],
    ["工具调用", formatNumber(report.totals.toolCalls), report.totals.toolFailures ? `${report.totals.toolFailures} 次失败` : "全部成功或无结果"],
    ["模型耗时", formatDuration(report.totals.durationMs), "各轮耗时之和"],
    ["总 Token", formatNumber(report.totals.totalTokens), `输入 ${formatNumber(report.totals.inputTokens)} · 输出 ${formatNumber(report.totals.outputTokens)}`],
    ["缓存命中", cacheRatio, `${formatNumber(report.totals.cachedTokens)} input tokens`],
  ];
  return `<section class="metrics" aria-label="会话摘要">
    ${metrics
      .map(
        ([label, value, hint]) => `<div class="metric">
          <div class="metric-label">${escapeHtml(label)}</div>
          <div class="metric-value">${escapeHtml(value)}</div>
          <div class="metric-hint">${escapeHtml(hint)}</div>
        </div>`,
      )
      .join("\n")}
  </section>`;
}

function renderConfiguration(report: TraceReport, requestModel: string, responseModel: string): string {
  const repeatedInstructions = Math.max(0, report.turns.length - report.instructionVariants);
  const repeatedTools = Math.max(0, report.turns.length - report.toolDefinitionVariants);
  return `<section class="config" aria-labelledby="config-title">
    <div class="section-heading">
      <div>
        <div class="eyebrow">SESSION-LEVEL CONTEXT</div>
        <h2 id="config-title">会话配置（只展示一次）</h2>
      </div>
      <span class="dedupe-note">已从每轮视图折叠 ${formatNumber(repeatedInstructions)} 份重复 instructions 和 ${formatNumber(repeatedTools)} 份重复工具定义</span>
    </div>
    <dl class="config-grid">
      <div><dt>Endpoint</dt><dd><code>${escapeHtml(report.endpoint ?? "未知")}</code></dd></div>
      <div><dt>请求模型</dt><dd>${escapeHtml(requestModel)}</dd></div>
      <div><dt>响应模型</dt><dd>${escapeHtml(responseModel)}</dd></div>
      <div><dt>会话时间</dt><dd>${escapeHtml(formatTimestamp(report.startedAt))} → ${escapeHtml(formatTimestamp(report.completedAt))}</dd></div>
      <div><dt>store</dt><dd>${formatBoolean(report.store)}</dd></div>
      <div><dt>parallel_tool_calls</dt><dd>${formatBoolean(report.parallelToolCalls)}</dd></div>
    </dl>
    <div class="config-details">
      <details>
        <summary><span>instructions</span><span class="summary-meta">${formatNumber(report.instructions.length)} 字符 · ${formatNumber(report.instructionVariants)} 个版本</span></summary>
        <pre>${escapeHtml(report.instructions || "（空）")}</pre>
      </details>
      <details>
        <summary><span>工具目录</span><span class="summary-meta">${formatNumber(report.tools.length)} 个工具 · ${formatNumber(report.toolDefinitionVariants)} 个版本</span></summary>
        <div class="tool-catalog">${report.tools.map(renderToolDefinition).join("\n") || "<p>没有工具定义。</p>"}</div>
      </details>
    </div>
  </section>`;
}

function renderToolDefinition(tool: TraceToolDefinition): string {
  return `<details class="tool-definition">
    <summary><code>${escapeHtml(tool.name)}${tool.strict === true ? " · strict" : ""}</code><span>${escapeHtml(tool.description)}</span></summary>
    <pre>${escapeHtml(prettyJson(tool.schema))}</pre>
  </details>`;
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `<aside class="warnings" aria-label="解析警告">
    <strong>解析时发现 ${formatNumber(warnings.length)} 个问题</strong>
    <ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
  </aside>`;
}

function renderTurn(turn: TraceTurn): string {
  const hasFailure = Boolean(turn.error) || turn.toolCalls.some((call) => call.result?.ok === false);
  const isFinal = !turn.error && turn.toolCalls.length === 0 && turn.assistantMessages.length > 0;
  const kinds = [turn.toolCalls.length ? "tools" : "", hasFailure ? "errors" : "", isFinal ? "final" : ""]
    .filter(Boolean)
    .join(" ");
  const resultCount = turn.returnedToolResults.length;

  return `<article class="turn${hasFailure ? " turn-error" : ""}${isFinal ? " turn-final" : ""}" data-kind="${kinds}" id="turn-${turn.index}">
    <div class="turn-rail"><span>${turn.index}</span></div>
    <div class="turn-body">
      <header class="turn-header">
        <div>
          <h3>第 ${formatNumber(turn.index)} 次模型请求</h3>
          <div class="turn-time">${escapeHtml(formatTimestamp(turn.startedAt))}</div>
        </div>
        <div class="turn-badges">
          ${turn.httpStatus ? `<span class="badge ${turn.httpStatus >= 400 ? "bad" : "good"}">HTTP ${turn.httpStatus}</span>` : ""}
          ${turn.durationMs !== undefined ? `<span class="badge">${escapeHtml(formatDuration(turn.durationMs))}</span>` : ""}
          ${turn.usage.totalTokens ? `<span class="badge">${formatNumber(turn.usage.totalTokens)} tokens</span>` : ""}
        </div>
      </header>

      ${renderConfigChanges(turn.configChanges)}
      ${turn.userInputs.map(renderUserInput).join("\n")}
      ${resultCount > 0 ? `<div class="continuation"><span>↳</span> 收到上一轮 ${formatNumber(resultCount)} 个工具结果后继续推理</div>` : ""}
      ${turn.reasoningSummaries.map(renderReasoning).join("\n")}
      ${turn.assistantMessages.map((message) => renderAssistantMessage(message, isFinal)).join("\n")}
      ${turn.toolCalls.length > 0 ? `<div class="tool-call-list">${turn.toolCalls.map(renderToolCall).join("\n")}</div>` : ""}
      ${turn.error ? renderError(turn.error) : ""}
      ${renderTurnFooter(turn)}
      ${renderRawTrace(turn)}
    </div>
  </article>`;
}

function renderConfigChanges(changes: string[]): string {
  if (changes.length === 0) return "";
  return `<div class="config-change"><strong>配置变化</strong> ${changes.map(escapeHtml).join("；")}</div>`;
}

function renderUserInput(input: string): string {
  return `<section class="event user-event">
    <div class="event-label"><span class="event-dot user-dot"></span>用户输入</div>
    <div class="message-text">${escapeHtml(input)}</div>
  </section>`;
}

function renderReasoning(reasoning: string): string {
  return `<details class="event reasoning-event">
    <summary><span class="event-label"><span class="event-dot reasoning-dot"></span>模型计划 / reasoning summary</span></summary>
    <div class="message-text">${escapeHtml(reasoning)}</div>
  </details>`;
}

function renderAssistantMessage(message: string, isFinal: boolean): string {
  return `<section class="event assistant-event${isFinal ? " final-answer" : ""}">
    <div class="event-label"><span class="event-dot assistant-dot"></span>${isFinal ? "最终回答" : "模型消息"}</div>
    <div class="message-text">${escapeHtml(message.trim())}</div>
  </section>`;
}

function renderToolCall(call: TraceToolCall): string {
  const result = call.result;
  const stateClass = result?.ok === false ? "failed" : result ? "succeeded" : "pending";
  const stateText = result?.ok === false ? "失败" : result ? "已返回" : "无结果";
  return `<section class="tool-call ${stateClass}">
    <header>
      <div class="tool-name"><span class="tool-icon">⌁</span><code>${escapeHtml(call.name)}</code></div>
      <span class="tool-state">${stateText}</span>
    </header>
    <div class="argument-summary">${escapeHtml(summarizeArguments(call.arguments))}</div>
    <details>
      <summary>调用参数</summary>
      <pre>${escapeHtml(prettyJson(call.arguments))}</pre>
    </details>
    ${result ? renderToolResult(result) : ""}
  </section>`;
}

function renderToolResult(result: TraceToolResult): string {
  return `<div class="tool-result${result.ok === false ? " result-error" : ""}">
    <div class="result-label">工具结果</div>
    <div class="result-summary">${escapeHtml(summarizeToolResult(result))}</div>
    <details>
      <summary>完整结果</summary>
      <pre>${escapeHtml(prettyJson(result.parsedOutput))}</pre>
    </details>
  </div>`;
}

function renderError(error: NonNullable<TraceTurn["error"]>): string {
  return `<section class="event request-error">
    <div class="event-label"><span class="event-dot error-dot"></span>模型请求失败${error.status ? ` · HTTP ${error.status}` : ""}</div>
    <div class="message-text"><strong>${escapeHtml(error.name)}</strong>：${escapeHtml(error.message)}</div>
    ${error.body === undefined ? "" : `<details><summary>错误响应</summary><pre>${escapeHtml(prettyJson(error.body))}</pre></details>`}
  </section>`;
}

function renderTurnFooter(turn: TraceTurn): string {
  if (!turn.usage.totalTokens && !turn.responseId) return "";
  return `<footer class="turn-footer">
    ${turn.usage.totalTokens ? `<span>输入 ${formatNumber(turn.usage.inputTokens)}</span><span>输出 ${formatNumber(turn.usage.outputTokens)}</span><span>缓存 ${formatNumber(turn.usage.cachedTokens)}</span><span>推理 ${formatNumber(turn.usage.reasoningTokens)}</span>` : ""}
    ${turn.responseId ? `<span title="${escapeHtml(turn.responseId)}">response · ${escapeHtml(shortId(turn.responseId))}</span>` : ""}
  </footer>`;
}

function renderRawTrace(turn: TraceTurn): string {
  if (!turn.rawRequest && !turn.rawResponse && !turn.rawError) return "";
  return `<details class="raw-trace">
    <summary>原始记录（仅排障时展开）</summary>
    ${turn.rawRequest ? `<h4>Request</h4><pre>${escapeHtml(prettyJson(turn.rawRequest))}</pre>` : ""}
    ${turn.rawResponse ? `<h4>Response</h4><pre>${escapeHtml(prettyJson(turn.rawResponse))}</pre>` : ""}
    ${turn.rawError ? `<h4>Error</h4><pre>${escapeHtml(prettyJson(turn.rawError))}</pre>` : ""}
  </details>`;
}

function renderEmptyState(): string {
  return `<div class="empty-state">没有找到可展示的 OpenAI 请求或响应。</div>`;
}

function summarizeArguments(value: unknown): string {
  if (typeof value === "string") return truncate(value, 180);
  if (!isRecord(value)) return prettyJson(value);
  const preferredKeys = ["path", "query", "task", "name", "maxResults", "lineStart", "lineEnd"];
  const entries = [...preferredKeys, ...Object.keys(value)]
    .filter((key, index, keys) => keys.indexOf(key) === index && value[key] !== undefined)
    .slice(0, 4)
    .map((key) => `${key}: ${formatInline(value[key])}`);
  return entries.join(" · ") || "无参数";
}

function summarizeToolResult(result: TraceToolResult): string {
  if (result.ok === false) {
    const object = isRecord(result.parsedOutput) ? result.parsedOutput : undefined;
    return `失败：${truncate(typeof object?.error === "string" ? object.error : result.rawOutput, 240)}`;
  }

  const envelope = isRecord(result.parsedOutput) ? result.parsedOutput : undefined;
  const value = envelope && "result" in envelope ? envelope.result : result.parsedOutput;
  if (isRecord(value) && Array.isArray(value.entries)) {
    return `返回 ${formatNumber(value.entries.length)} 个目录项${value.truncated === true ? "，列表已截断" : ""}`;
  }
  if (isRecord(value) && Array.isArray(value.directories) && Array.isArray(value.files)) {
    return `返回 ${formatNumber(value.directories.length)} 个目录、${formatNumber(value.files.length)} 个文件${value.truncated === true ? "，列表已截断" : ""}`;
  }
  if (isRecord(value) && Array.isArray(value.files)) {
    return `返回 ${formatNumber(value.files.length)} 个文件${value.truncated === true ? "，列表已截断" : ""}`;
  }
  if (isRecord(value) && Array.isArray(value.matches)) {
    return `返回 ${formatNumber(value.matches.length)} 个匹配项`;
  }
  if (isRecord(value) && typeof value.content === "string") {
    return `读取 ${formatNumber(value.content.split(/\r?\n/u).length)} 行、${formatNumber(value.content.length)} 字符`;
  }
  if (typeof value === "string") return truncate(value, 240);
  return truncate(prettyJson(value), 240);
}

function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function formatInline(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(truncate(value, 90));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return truncate(prettyJson(value).replace(/\s+/gu, " "), 90);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${formatNumber(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatBoolean(value: boolean | undefined): string {
  return value === undefined ? "未知" : value ? "true" : "false";
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCRIPT = String.raw`
const buttons = [...document.querySelectorAll('.filter')];
const turns = [...document.querySelectorAll('.turn')];
const search = document.querySelector('#trace-search');
let activeFilter = 'all';

function applyFilters() {
  const query = search.value.trim().toLocaleLowerCase();
  for (const turn of turns) {
    const kinds = turn.dataset.kind || '';
    const matchesKind = activeFilter === 'all' || kinds.split(' ').includes(activeFilter);
    const matchesText = query === '' || turn.textContent.toLocaleLowerCase().includes(query);
    turn.hidden = !matchesKind || !matchesText;
  }
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    for (const item of buttons) item.classList.toggle('active', item === button);
    applyFilters();
  });
}
search.addEventListener('input', applyFilters);
`;

const STYLES = String.raw`
:root {
  --bg: #f5f3ee;
  --surface: #fffdf8;
  --surface-2: #f0ede5;
  --ink: #20201d;
  --muted: #6e6b63;
  --line: #d8d3c7;
  --accent: #196b62;
  --accent-soft: #dcece7;
  --user: #8b5e22;
  --assistant: #315f9b;
  --danger: #a43c32;
  --danger-soft: #f6ded9;
  --success: #27764c;
  --shadow: 0 12px 34px rgb(54 48 37 / 8%);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--bg); line-height: 1.55; }
.shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 64px 0 96px; }
.hero { padding: 8px 0 30px; border-bottom: 1px solid var(--line); }
.eyebrow { color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .16em; }
h1, h2, h3, h4, p { margin-top: 0; }
h1 { margin: 8px 0 12px; font-family: ui-serif, Georgia, serif; font-size: clamp(38px, 6vw, 68px); letter-spacing: -.035em; line-height: 1; }
h2 { margin: 5px 0 0; font-size: 24px; letter-spacing: -.02em; }
h3 { margin: 0; font-size: 18px; }
.task { max-width: 820px; margin-bottom: 18px; color: var(--muted); font-size: 18px; white-space: pre-wrap; }
.source { max-width: 100%; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.metrics { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; margin: 28px 0; overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--line); box-shadow: var(--shadow); }
.metric { min-width: 0; padding: 18px; background: var(--surface); }
.metric-label, .metric-hint { color: var(--muted); font-size: 12px; }
.metric-value { margin: 5px 0 2px; font-size: 25px; font-weight: 750; letter-spacing: -.03em; }
.metric-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config { margin: 28px 0 52px; padding: 26px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow); }
.section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.dedupe-note { max-width: 520px; padding: 7px 10px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); font-size: 12px; text-align: right; }
.config-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px 24px; margin: 0 0 22px; }
.config-grid > div { min-width: 0; }
.config-grid dt { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.config-grid dd { margin: 4px 0 0; overflow-wrap: anywhere; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
.config-details { display: grid; gap: 8px; }
details { border-radius: 9px; }
summary { cursor: pointer; }
.config-details > details { border: 1px solid var(--line); background: var(--surface-2); }
.config-details > details > summary { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; font-weight: 700; }
.summary-meta { color: var(--muted); font-size: 12px; font-weight: 500; }
pre { max-height: 520px; margin: 0; padding: 14px; overflow: auto; border-radius: 8px; color: var(--ink); background: #e8e5dd; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.config-details > details > pre { margin: 0 12px 12px; }
.tool-catalog { display: grid; gap: 7px; padding: 0 12px 12px; }
.tool-definition { border: 1px solid var(--line); background: var(--surface); }
.tool-definition summary { display: grid; grid-template-columns: minmax(120px, .35fr) 1fr; gap: 12px; padding: 10px 12px; }
.tool-definition summary span { color: var(--muted); font-size: 13px; }
.tool-definition pre { margin: 0 10px 10px; }
.warnings { margin: -32px 0 48px; padding: 16px 18px; border-left: 4px solid var(--danger); background: var(--danger-soft); }
.warnings ul { margin-bottom: 0; }
.flow-section { position: relative; }
.sticky-tools { align-items: center; }
.toolbar { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
.toolbar input, .toolbar button { min-height: 36px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: var(--surface); font: inherit; font-size: 12px; }
.toolbar input { width: 225px; padding: 7px 10px; }
.toolbar button { padding: 7px 11px; cursor: pointer; }
.toolbar button.active { border-color: var(--accent); color: #fff; background: var(--accent); }
.timeline { position: relative; }
.timeline::before { position: absolute; top: 22px; bottom: 22px; left: 22px; width: 1px; content: ""; background: var(--line); }
.turn { position: relative; display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 16px; margin-bottom: 24px; }
.turn[hidden] { display: none; }
.turn-rail { z-index: 1; padding-top: 16px; }
.turn-rail span { display: grid; width: 44px; height: 44px; place-items: center; border: 1px solid var(--line); border-radius: 50%; color: var(--accent); background: var(--surface); font-weight: 800; box-shadow: 0 3px 10px rgb(54 48 37 / 8%); }
.turn-final .turn-rail span { color: #fff; border-color: var(--accent); background: var(--accent); }
.turn-error .turn-rail span { color: #fff; border-color: var(--danger); background: var(--danger); }
.turn-body { min-width: 0; padding: 20px; border: 1px solid var(--line); border-radius: 15px; background: var(--surface); box-shadow: var(--shadow); }
.turn-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 15px; border-bottom: 1px solid var(--line); }
.turn-time { margin-top: 3px; color: var(--muted); font-size: 12px; }
.turn-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.badge { padding: 3px 8px; border: 1px solid var(--line); border-radius: 99px; color: var(--muted); background: var(--surface-2); font-size: 11px; }
.badge.good { color: var(--success); border-color: color-mix(in srgb, var(--success), transparent 55%); }
.badge.bad { color: var(--danger); border-color: color-mix(in srgb, var(--danger), transparent 55%); }
.config-change { margin-top: 14px; padding: 9px 11px; border-radius: 8px; color: #765210; background: #f5e8c7; font-size: 12px; }
.event { margin-top: 14px; padding: 14px; border: 1px solid var(--line); border-radius: 11px; }
.event-label { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.event-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.user-dot { background: var(--user); }
.assistant-dot { background: var(--assistant); }
.reasoning-dot { background: var(--accent); }
.error-dot { background: var(--danger); }
.message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.user-event { border-left: 4px solid var(--user); }
.assistant-event { border-left: 4px solid var(--assistant); }
.final-answer { border-color: color-mix(in srgb, var(--accent), transparent 45%); border-left: 4px solid var(--accent); background: color-mix(in srgb, var(--accent-soft), transparent 35%); }
.reasoning-event { background: var(--surface-2); }
.reasoning-event summary { list-style-position: outside; }
.reasoning-event summary .event-label { display: inline-flex; margin: 0; }
.reasoning-event .message-text { margin-top: 10px; color: var(--muted); font-size: 13px; }
.continuation { margin: 14px 0 0; color: var(--muted); font-size: 12px; }
.continuation span { color: var(--accent); font-size: 18px; }
.tool-call-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.tool-call { min-width: 0; padding: 13px; border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: 11px; background: var(--surface-2); }
.tool-call.failed { border-top-color: var(--danger); }
.tool-call.pending { border-top-color: var(--muted); }
.tool-call > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.tool-name { display: flex; min-width: 0; align-items: center; gap: 7px; font-weight: 750; }
.tool-icon { color: var(--accent); font-size: 18px; }
.tool-state { flex: 0 0 auto; color: var(--success); font-size: 11px; }
.failed .tool-state { color: var(--danger); }
.pending .tool-state { color: var(--muted); }
.argument-summary { margin: 8px 0 10px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
.tool-call details summary, .tool-result details summary { color: var(--muted); font-size: 11px; }
.tool-call details pre, .tool-result details pre { margin-top: 7px; max-height: 330px; background: #dfdcd3; }
.tool-result { margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line); }
.result-label { color: var(--success); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.result-error .result-label { color: var(--danger); }
.result-summary { margin: 3px 0 7px; font-size: 12px; overflow-wrap: anywhere; }
.request-error { border-color: var(--danger); background: var(--danger-soft); }
.turn-footer { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; padding-top: 13px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
.turn-footer span:last-child { margin-left: auto; }
.raw-trace { margin-top: 12px; color: var(--muted); font-size: 11px; }
.raw-trace > summary { width: max-content; max-width: 100%; }
.raw-trace h4 { margin: 12px 0 5px; color: var(--ink); }
.raw-trace pre { max-height: 640px; }
.empty-state { padding: 40px; border: 1px dashed var(--line); border-radius: 12px; color: var(--muted); text-align: center; }
@media (max-width: 900px) {
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .metric:last-child { grid-column: span 2; }
  .config-grid { grid-template-columns: repeat(2, 1fr); }
  .tool-call-list { grid-template-columns: 1fr; }
  .section-heading { align-items: flex-start; flex-direction: column; }
  .dedupe-note { text-align: left; }
  .toolbar { justify-content: flex-start; }
}
@media (max-width: 560px) {
  .shell { width: min(100% - 20px, 1180px); padding-top: 34px; }
  .metrics, .config-grid { grid-template-columns: 1fr; }
  .metric:last-child { grid-column: auto; }
  .config { padding: 17px; }
  .turn { grid-template-columns: 32px minmax(0, 1fr); gap: 8px; }
  .timeline::before { left: 15px; }
  .turn-rail span { width: 31px; height: 31px; font-size: 12px; }
  .turn-body { padding: 14px; }
  .turn-header { flex-direction: column; }
  .turn-badges { justify-content: flex-start; }
  .toolbar input { width: 100%; }
  .tool-definition summary { grid-template-columns: 1fr; }
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #171916;
    --surface: #20231f;
    --surface-2: #292c27;
    --ink: #ecece5;
    --muted: #aaa99f;
    --line: #3c4039;
    --accent: #68c4b4;
    --accent-soft: #263e39;
    --user: #d7a05b;
    --assistant: #81aee6;
    --danger: #ec7c70;
    --danger-soft: #4a2926;
    --success: #78c997;
    --shadow: none;
  }
  pre { background: #151714; }
  .tool-call details pre, .tool-result details pre { background: #171a16; }
  .config-change { color: #f0ca79; background: #443a22; }
  .toolbar button.active { color: #10201c; }
}
`;
