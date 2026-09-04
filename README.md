# Simple Code Agent

一个用于学习 Agent 工作方式的轻量 TypeScript 项目。它直接使用 OpenAI Responses API，实现模型调用、工具执行、权限审批和上下文管理。

## 特性

- 支持多轮工具调用和流式输出
- 使用 `apply_patch` 修改文件，使用 `run_command` 执行命令
- 支持多个 API 连接、模型切换和推理强度配置
- 自动加载项目 `AGENTS.md` 和本地 Skill
- 支持会话历史、恢复和上下文压缩
- 保存本地运行记录，并可生成 HTML Trace 报告
- 核心模块可独立复用，不依赖 Agent 框架

## 快速开始

需要 Node.js 20 或更高版本。

```bash
npm install
```

在启动目录创建 `.config/config.json`：

```json
{
  "defaults": {
    "model": "model-a",
    "reasoningEffort": "medium",
    "reasoningSummary": "auto"
  },
  "connections": [
    {
      "apiKey": "your-api-key",
      "baseUrl": "https://provider.example.com/v1",
      "models": [
        {
          "id": "model-a",
          "contextWindow": 300000,
          "supportedReasoningEfforts": ["low", "medium", "high"]
        }
      ]
    }
  ]
}
```

- `defaults.model` 指定启动时使用的模型；省略时使用第一个连接的第一个模型。
- `contextWindow` 用于计算上下文预算；配置后支持自动压缩。
- 模型可以覆盖默认的推理配置。
- 如果多个连接包含同名模型，使用 `/model` 显示的编号选择器，例如 `1:model-a`。

启动 Agent：

```bash
npm run dev -- --workspace .
```

启动后直接输入自然语言任务，例如：

```text
agent> 阅读这个项目并说明核心流程
agent> 为这个功能补充测试
```

查看所有启动参数：

```bash
npm run dev -- --help
```

## 常用命令

- `/model`：查看或切换模型
- `/reasoning`：查看或修改推理强度
- `/history`：查看历史会话
- `/resume <序号或 ID>`：恢复会话
- `/compact [要求]`：压缩较早的上下文
- `/trace`：生成当前会话的 HTML 报告
- `/new`：开启新会话
- `/rename <标题>`：修改当前会话标题
- `/help`：查看帮助
- `/exit`：退出

默认启用流式输出。使用 `--no-stream` 可以等待完整响应后再显示，使用 `--debug` 可以记录原始模型请求和响应。

## 项目指令与 Skill

Agent 会自动加载工作区中的 `AGENTS.md` 和 `AGENTS.override.md`。

Skill 默认从以下位置发现：

- `<workspace>/.agents/skills`
- `~/.agents/skills`
- `CODE_AGENT_SKILL_ROOTS` 指定的目录
- `--skill-root <path>` 指定的目录

加载仓库中的示例 Skill：

```bash
npm run dev -- --workspace . --skill-root ./examples/skills
```

## 安全与数据

- `apply_patch` 只能修改工作区内允许的文件，CLI 默认自动批准。
- `run_command` 默认需要用户确认；仅在受信环境中使用 `--yes` 跳过确认。
- 命令执行不是操作系统沙箱，不要直接运行不受信任的脚本。
- 会话保存在 `.agent-runs/`，其中可能包含用户输入、源码和模型输出，请勿提交到版本库。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

主要代码：

- `src/core/agent-runner.ts`：Agent 工具循环
- `src/config/app-config.ts`：连接和模型配置
- `src/model/`：模型适配与路由
- `src/tools/`：文件修改和命令执行
- `src/history/session-store.ts`：会话记录与恢复
- `src/cli/`：命令行入口和交互会话
