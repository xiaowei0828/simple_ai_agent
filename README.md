# Simple Code Agent

一个用于研究 Agent 原理的最小 TypeScript Code Agent。它直接基于 OpenAI Responses API 的 function calling 实现，不依赖 LangChain 等 Agent 框架，因此模型调用、工具循环、上下文注入、权限审批和终止条件都能在源码中直接看到。

## 它实现了什么

- Responses API 的多轮工具调用循环，并通过 `previous_response_id` 延续交互式会话
- 默认启用 `parallel_tool_calls`，允许模型在一轮中批量返回多个独立工具调用；Host 顺序完成参数校验和审批，纯只读批次并发执行，包含写入或命令的批次按模型顺序执行
- SDK 负责建连和响应头阶段的重试；适配层在响应体提前终止、且尚未输出任何流式 delta 时默认额外重试一次，可通过 `OpenAIModelOptions.maxTransportRetries` 调整为 0–3 次。终态事件一旦到达便直接采用，不依赖后续 `[DONE]`；兼容接口若不提供请求幂等保证，重试仍可能在服务端产生额外响应
- 七个基础工具：`list_directory`、`read_file`、`search_code`、`write_file`、`replace_in_file`、`delete_file`、`run_command`；发现 Skill 时额外注册 `load_skill`
- `read_file` / `load_skill` 使用显式续读游标；工具输出超出上下文预算时优先压缩正文并保留 `nextLine` / `nextOffset` 等结构化字段
- `search_code` 同时支持文件和目录、字面量大小写匹配、路径 glob 与上下文行；空 glob 等价于不筛选，目录发现、单文件大小、累计读取量和 12000 字符结构化结果都有硬上限，未完整扫描会返回原因
- 工作区内的新建、修改、删除文件由宿主策略自动批准；`run_command` 支持逐次审批和受信环境下的 `--yes`
- 工作区路径限制、符号链接逃逸检查、常见密钥文件拦截
- 测试子进程会移除名称类似 token、secret、password、API key 的环境变量
- `AGENTS.md` / `AGENTS.override.md` 项目指令加载
- Markdown 文档目录：只注入路径和标题，需要时再读取正文
- 本地 Skill 目录：只注入名称和描述，需要时通过 `load_skill` 加载完整 `SKILL.md`
- `--debug` 将每次 OpenAI 原始请求和完整响应写入私有 JSONL 日志
- `--stream` 通过 Responses API 事件流实时显示推理摘要和回答正文
- 可替换的 `ModelAdapter`，测试使用假模型，不消耗 API 调用

## 运行原理

```mermaid
flowchart LR
    U["用户任务 / VS Code UI"] --> H["Host: CLI 或 VS Code"]
    H --> C["Context Builder"]
    C --> A["AgentRunner"]
    A --> M["OpenAI Responses API"]
    M -->|"function_call"| A
    A --> P{"Policy / Approval"}
    P -->|"允许"| T["Tool Registry"]
    P -->|"拒绝"| A
    T -->|"function_call_output"| A
    M -->|"最终文本"| H
```

核心循环位于 `src/core/agent-runner.ts`：

1. 把任务、系统指令和工具 JSON Schema 发给模型。
2. 如果模型返回一个或多个 `function_call`，按顺序解析并用 Zod 校验参数。
3. 写操作和进程执行先交给 `ApprovalPolicy`；预检完成后，纯只读批次并发执行，包含写入或命令的批次保持顺序执行。工作区文件操作由宿主策略自动批准，`run_command` 交给用户确认。
4. 把结构化工具结果作为 `function_call_output` 发回模型。
5. 模型不再调用工具时结束；超过最大轮数则强制停止。

这个流程对应 OpenAI 官方的 [function calling 工具循环](https://developers.openai.com/api/docs/guides/function-calling)。

## 快速开始

要求 Node.js 20 或更高版本。

```bash
npm install
npm run dev -- --workspace .
```

启动时会读取当前目录的 `.config/config.json`：

```json
{
  "apiKey": "your-api-key",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
  "models": {
    "default": "deepseek-v4-flash",
    "available": ["deepseek-v4-flash"]
  },
  "reasoningSummary": "auto"
}
```

`.config/` 已被 Git 和 Agent 文件工具忽略，避免 API Key 被提交或重新送入模型上下文。`models.default` 必须出现在 `models.available` 中。`reasoningSummary` 控制是否请求并在 console 中显示模型提供的推理摘要，可选值为 `off`、`auto`、`concise` 或 `detailed`，省略时默认为 `auto`。命令行 `--model` 可覆盖默认模型，`OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 可覆盖配置文件中的对应值：

CLI 优先显示 API 返回的 reasoning summary。部分兼容接口（例如启用了 reasoning parser 的 vLLM）会改为返回 `reasoning_text`；此时 CLI 会显示接口明确提供的原始推理文本，HTML 运行报告也会将它标记为 `reasoning text`。这类内容可能包含完整思考过程，请注意 console 输出和 `.agent-runs/` 日志的访问范围。如果兼容接口明确拒绝 reasoning summary 参数，CLI 会提示一次，自动重试普通请求，并在当前进程内不再为该模型请求摘要。

```bash
export OPENAI_BASE_URL="https://provider.example.com/v1"
npm run dev -- --workspace . --model "provider-model"
```

启动后输入自然语言任务：

```text
Interactive mode. Type /help for commands.
agent> 阅读这个项目，说明 Agent 的工具调用链路
thinking> 我需要先查看项目结构以及 AgentRunner 的实现。
assistant> ...

agent> 继续解释工具审批是怎么实现的
assistant> ...
```

也可以执行一次性任务，输出结果后立即退出：

```bash
npm run dev -- --workspace /path/to/project "修复失败的单元测试"
```

如果既提供初始任务又希望继续对话，使用：

```bash
npm run dev -- --interactive "先介绍项目结构"
```

默认使用非流式响应。需要实时显示模型输出时，只需增加 `--stream`，不需要修改配置文件：

```bash
npm run dev -- --stream --workspace .
npm run dev -- --stream --interactive "先介绍项目结构"
```

流式模式只实时展示增量内容；工具调用仍会等待完整参数生成后再校验和审批，历史记录也只在收到最终响应后保存。

CLI 默认批准 workspace 内的结构化文件操作；每次 `run_command` 都会显示命令并询问。查看全部选项：

```bash
npm run dev -- --help
```

## 通用命令执行

模型可以通过一个结构化的 `run_command` 工具运行构建、测试和版本控制命令，不需要为 CMake、Make、Git、Cargo 等程序分别定义 function：

```json
{
  "command": "cmake -S . -B build && cmake --build build",
  "cwd": ".",
  "timeoutMs": 600000
}
```

`run_command` 接收完整的 Shell 命令字符串。Windows 使用无 Profile 的非交互 PowerShell；macOS 使用 `$SHELL`（未设置时回退 `/bin/zsh`），同样以非交互模式启动。当前 Shell 的名称和路径会写入模型 instructions，因此模型会使用对应语法。`&&`、管道、重定向、变量和其它 Shell 语法会直接交给 Shell 解析。

Host 验证 `run_command` 的工作目录仍在 workspace 内，同时移除名称类似 API key、token、secret、password 的环境变量，并限制执行时间和回传输出。每次调用都会交给 Host 审批；交互提示中输入 `y` 仅批准本次，输入 `n` 或直接回车则拒绝。受信环境可以使用 `--yes` 跳过 `run_command` 确认。内置文件工具只能操作 workspace 内的路径，其新建、修改和删除操作默认批准。

这套策略是教育项目中的防误操作边界，不是完整的操作系统沙箱。对不受信任的仓库执行构建脚本时，还应使用容器或 OS 沙箱限制文件系统和网络访问。

## 交互式会话

每轮成功响应的 `responseId` 会作为下一轮请求的 `previous_response_id`，因此“继续解释”“修改刚才提到的文件”等追问能看到此前上下文。具体机制参考 OpenAI 官方的 [conversation state](https://developers.openai.com/api/docs/guides/conversation-state)。

成功完成的交互会话还会保存在工作区的 `.agent-history/` 中。直接启动交互模式且没有传入初始任务时，CLI 会列出最近的历史会话，可以输入序号或 ID 前缀继续，也可以输入 `0` 开启新对话。恢复会话时优先使用保存的 `responseId`；如果兼容 API 已经删除了对应的远端 response，则自动回放本地保存的 user/assistant 消息并建立新的 response 链。

每个历史文件包含会话标题、模型、时间、最后一个 response ID 以及成功完成的消息轮次。默认标题取第一条用户消息的前 60 个字符，使用 `/rename` 可以修改。历史按工作区隔离，不会在不同代码仓库之间混用。

交互命令：

- `/model`：显示当前模型以及 `.config/config.json` 中的可用模型
- `/model <序号或名称>`：切换模型并开启新对话，例如 `/model 2` 或 `/model glm-5.3`
- `/history`：列出当前工作区保存的历史会话
- `/resume <序号或 ID 前缀>`：切换到某一个历史会话
- `/rename <标题>`：重命名当前历史会话
- `/trace`：把当前或最近的 `.agent-runs/*.jsonl` 生成为 HTML，并用系统默认浏览器打开
- `/new`：保留当前历史并让下一条消息开启独立对话
- `/help`：显示命令帮助
- `/exit` 或 `/quit`：退出
- `Ctrl+C` 或 `Ctrl+D`：关闭交互输入并退出

`/new` 和 `/resume` 只切换模型对话，不会撤销已经修改的工作区文件。工作区内的新建、修改和删除文件会自动批准；`run_command` 仍需逐次确认，`--yes` 可跳过确认。

`.agent-history/` 已被 Git 和 Agent 文件工具忽略。历史中仍可能包含用户输入、模型回复、源码片段或路径，因此不应把该目录提交或共享给其他人。

## 查看 OpenAI 原始请求和响应

使用 `--debug` 启用：

```bash
npm run dev -- --workspace . --debug
```

交互模式中输入 `/trace` 可以随时生成当前日志的 Trace Viewer 报告并自动打开浏览器；如果当前会话没有启用 `--debug`，则尝试打开工作区中最近一次已有日志。若没有任何日志，会提示使用 `--debug` 重新启动。

启动时会显示日志的绝对路径：

```text
agent: raw OpenAI log: /path/to/project/.agent-runs/2026-08-14T15-10-00-000Z-12345.jsonl
```

每次 API 调用产生两行具有相同 `traceId` 的 JSON：

```json
{"type":"openai.request","traceId":"...","endpoint":"https://ark.cn-beijing.volces.com/api/plan/v3/responses","body":{"model":"deepseek-v4-flash","instructions":"...","input":"...","tools":[...]}}
{"type":"openai.response","traceId":"...","requestId":"req_...","durationMs":1234,"http":{"status":200,"headers":{"x-request-id":"req_..."}},"body":{"id":"resp_...","output":[...],"usage":{...}}}
```

请求失败时记录 `openai.error`。日志内容包括完整 instructions、用户输入、工具 Schema、工具结果、模型正文、工具调用和 token usage。它不会记录 API Key、Authorization、Cookie 或 Base URL 中的认证信息。

日志文件权限设置为仅当前用户可读写（`0600`）。由于日志可能包含项目源码和用户数据：

- `.agent-runs/` 已被当前仓库的 `.gitignore` 忽略
- Agent 文件工具也禁止读取 `.agent-runs/`，避免日志再次进入模型上下文
- `.agent-history/` 同样被 `.gitignore` 和 Agent 文件工具屏蔽
- 对其他目标项目使用 `--workspace` 时，建议把 `.agent-runs/` 和 `.agent-history/` 加入该项目的 `.gitignore`

可以用 `jq` 格式化查看：

```bash
jq . .agent-runs/*.jsonl
```

### 生成交互流程报告

原始 JSONL 适合排障，但 `instructions`、工具 Schema、模型和 endpoint 会在多轮请求中重复。内置 Trace Viewer 会将日志归一化为“用户输入 → 模型计划/消息 → 工具调用 → 工具结果 → 最终回答”的时间线：

```bash
npm run trace:view -- libevent/.agent-runs/2026-08-14T08-40-16-401Z-63000.jsonl
```

默认在日志旁生成同名 `.html` 文件，也可以指定输出路径：

```bash
npm run trace:view -- run.jsonl --output reports/run.html
```

报告有以下处理：

- 把稳定的 `instructions`、工具定义、endpoint 和模型提升为会话级配置，只展示一次
- 按 `traceId` 配对 request/response，按 `call_id` 把下一轮的工具结果挂回对应调用
- 主时间线只展示任务、模型消息、工具参数摘要、成功/失败结果、耗时和 token
- 配置变化、孤立工具结果和损坏的 JSONL 行会明确标记
- 完整原始 request/response 仍保留在每轮底部的折叠区域

生成的报告是无外部依赖的单文件 HTML，可直接在浏览器中打开；它可能包含源码和模型上下文，因此同样使用 `0600` 文件权限，且不会自动上传或打开。

## 项目 Markdown 如何进入上下文

不同 Markdown 使用两种策略：

1. `AGENTS.md` 是约束，启动时全文注入。若为某个子目录运行 Agent，可沿目录层级加载；同一目录的 `AGENTS.override.md` 优先。
2. `README.md`、`docs/*.md` 等说明文档只把“路径 + 一级标题”放入目录。模型判断相关后再调用 `read_file`，避免大量无关内容占用上下文。

当前 CLI 的工作目录就是 `--workspace` 根目录。宿主以后可调用 `loadProjectInstructions(workspaceRoot, activeFileDirectory)`，从而让 VS Code 当前文件所在目录的指令生效。

## 公共 Skill 如何注册

Skill 的目录结构：

```text
<skill-root>/
└── code-review/
    └── SKILL.md
```

`SKILL.md` 推荐包含元数据：

```markdown
---
name: code-review
description: Review code for correctness and missing tests.
routing: Review code and identify missing tests.
---

# Workflow
...
```

Agent 默认扫描：

- 项目内的 `<workspace>/.agents/skills`
- 当前用户的 `~/.agents/skills`
- 环境变量 `CODE_AGENT_SKILL_ROOTS` 中的目录
- 重复的 `--skill-root <path>` 参数

例如加载仓库里的示例 Skill：

```bash
npm run dev -- --skill-root ./examples/skills '$code-review 检查当前实现'
```

启动阶段只向模型提供 Skill 名称和不超过 80 字符的 `routing`；没有 `routing` 时使用截短的 `description`。模型使用下面的调用读取 Skill 入口：

```json
{ "name": "code-review", "resource": "SKILL.md", "offset": null, "limit": null }
```

如果 `SKILL.md` 引用了同一 Skill 目录下的其他文件，仍通过 `load_skill` 渐进读取：

```json
{ "name": "code-review", "resource": "references/checklist.md", "offset": null, "limit": null }
```

单次最多返回 15000 字符；结果中的 `nextOffset` 非空时，用它作为下一次 `offset` 继续读取。所有 Skill 根中的名称必须全局唯一，同名不会静默覆盖。资源路径以对应 Skill 目录为根，不能通过绝对路径、`..` 或符号链接逃逸。机器公共目录可这样配置：

```bash
export CODE_AGENT_SKILL_ROOTS="/usr/local/share/code-agent/skills"
```

## 为什么第一版不用 Agent 框架

研究原理时，手写循环更合适：本项目核心只有模型适配器、循环、工具注册表、策略和上下文构建器。理解这些边界以后，可以保持工具与策略不变，把 `OpenAIModel` 替换为 OpenAI Agents SDK 或其他框架的适配器，再比较 tracing、handoff、memory 和 MCP 带来的价值。

## 接入 VS Code

VS Code 扩展只应作为 Host，复用这里的核心包：

- Webview/Chat Participant 收集任务并展示 `AgentEvent`
- `workspace.workspaceFolders` 提供 `workspaceRoot`
- `window.activeTextEditor` 提供当前文件目录，用于分层加载 `AGENTS.md`
- `window.showWarningMessage` 实现 `ApprovalPolicy`
- `WorkspaceEdit` 可以替换当前的文件写工具，以获得 diff 预览和 Undo
- `CancellationToken` 映射到 AgentRunner 的取消信号（可作为下一步练习）

不要把 OpenAI API Key 写进扩展源码；应使用 VS Code `SecretStorage`，或者让扩展连接一个本地/远端后端。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

测试覆盖工具调用回传、审批拒绝、轮数上限、路径逃逸、敏感文件、精确替换、项目指令、Markdown 目录和 Skill 发现。

## 代码导航

- `src/core/agent-runner.ts`：Agent 状态机和工具循环
- `src/cli/interactive-session.ts`：跨轮 responseId、交互命令和会话重置
- `src/logging/`：OpenAI 原始请求/响应的 JSONL 调试日志
- `src/model/openai-model.ts`：Responses API 适配器
- `src/tools/`：工具定义、参数 Schema 和执行逻辑
- `src/context/`：项目说明、Markdown 和 Skill 上下文
- `src/policy/`：审批及工作区安全边界
- `src/cli/main.ts`：CLI Host，可作为 VS Code Host 的参考
- `tests/`：不调用真实模型的行为测试
