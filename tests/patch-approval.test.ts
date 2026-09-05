import { mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/arguments.js";
import { AgentRunner } from "../src/core/agent-runner.js";
import type { ModelRequest } from "../src/core/types.js";
import { AutoApproveWorkspaceFileOperationsPolicy, CallbackApprovalPolicy } from "../src/policy/approval-policy.js";
import { createApplyPatchTool } from "../src/tools/apply-patch.js";
import { ToolRegistry } from "../src/tools/types.js";
import { createTempDirectoryFixture } from "./test-utils.js";

const createTempDirectory = createTempDirectoryFixture();

describe("patch approval boundaries", () => {
  it.each([
    { target: "relative", external: false, allow: false },
    { target: "absolute", external: false, allow: false },
    { target: "relative", external: true, allow: false },
    { target: "relative", external: true, allow: true },
    { target: "absolute", external: true, allow: true },
    { target: "absolute", external: true, allow: false, yes: true },
    { target: "move-out", external: true, allow: false, yes: true },
    { target: "symlink", external: true, allow: false },
    { target: "symlink", external: true, allow: true },
    { target: "mixed", external: true, allow: false },
    { target: "mixed", external: true, allow: true },
    { target: "move-out", external: true, allow: false },
    { target: "move-out", external: true, allow: true },
    { target: "move-in", external: true, allow: false },
    { target: "move-in", external: true, allow: true },
  ])("$target external=$external host approval=$allow --yes=$yes", async ({ target, external, allow, yes }) => {
    const parent = await realpath(await createTempDirectory("patch-approval-"));
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    const destination = path.join(external ? outside : root, "new/deep/file.txt");
    let targetPath = target === "absolute" ? destination : path.relative(root, destination);
    if (target === "symlink") {
      await symlink(outside, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
      targetPath = "alias/new/deep/file.txt";
    }
    let body = `*** Add File: ${targetPath.split(path.sep).join("/")}\n+saved`;
    if (target === "mixed") body = `*** Add File: inside.txt\n+saved\n${body}`;
    let expected = destination;
    let source: string | undefined;
    if (target.startsWith("move-")) {
      source = path.join(target === "move-in" ? outside : root, "source.txt");
      expected = path.join(target === "move-in" ? root : outside, "moved.txt");
      await writeFile(source, "saved\n");
      body = `*** Update File: ${source.split(path.sep).join("/")}\n*** Move to: ${expected.split(path.sep).join("/")}`;
    }
    let confirmations = 0;
    const requests: ModelRequest[] = [];
    const runner = new AgentRunner({
      model: { async respond(request) {
        requests.push(request);
        return requests.length === 1
          ? { id: "call", outputText: "", toolCalls: [{ callId: "patch", name: "apply_patch", arguments: JSON.stringify({ patch: `*** Begin Patch\n${body}\n*** End Patch` }) }] }
          : { id: "done", outputText: "done", toolCalls: [] };
      } },
      modelName: "test", instructions: "test", tools: new ToolRegistry([createApplyPatchTool()]),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AutoApproveWorkspaceFileOperationsPolicy(new CallbackApprovalPolicy(() => {
        confirmations++;
        return allow;
      }), root, parseCliArgs(yes ? ["--yes"] : []).autoApprove),
    });
    await runner.run("Apply the patch.");
    expect(confirmations).toBe(external && !yes ? 1 : 0);
    if (target === "mixed") {
      if (allow) expect(await readFile(path.join(root, "inside.txt"), "utf8")).toBe("saved\n");
      else await expect(readFile(path.join(root, "inside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    if (!external || allow || yes) {
      expect(await readFile(expected, "utf8")).toBe("saved\n");
      if (source) await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(readFile(expected)).rejects.toMatchObject({ code: "ENOENT" });
      if (source) expect(await readFile(source, "utf8")).toBe("saved\n");
      expect(JSON.stringify(requests[1]?.input)).toContain("User denied");
    }
  });

  it("rejects a parent redirected outside after approval", async () => {
    const root = await createTempDirectory("patch-race-");
    const outside = await createTempDirectory("patch-race-outside-");
    await mkdir(path.join(root, "src"));
    const tool = createApplyPatchTool();
    const input = await tool.prepare!(tool.parse({ patch: "*** Begin Patch\n*** Add File: src/new.txt\n+saved\n*** End Patch" }), { workspaceRoot: root });
    const policy = new AutoApproveWorkspaceFileOperationsPolicy(new CallbackApprovalPolicy(() => false), root);
    expect(await policy.approve({ toolName: "apply_patch", risk: "write", arguments: input })).toBe(true);
    await rename(path.join(root, "src"), path.join(root, "original"));
    await symlink(outside, path.join(root, "src"), process.platform === "win32" ? "junction" : "dir");
    await expect(tool.execute(input, { workspaceRoot: root })).rejects.toThrow("changed after approval");
    expect(await readdir(outside)).toEqual([]);
  });
});
