import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  CommandAllowlistStore,
  loadCommandAllowlist,
  resolveCommandAllowlistPath,
} from "../src/config/command-allowlist.js";
import { resolveAppConfigPath } from "../src/config/app-config.js";

describe("command allowlist configuration", () => {
  it("persists programs beside the app configuration and reloads them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-command-allowlist-"));
    const filePath = resolveCommandAllowlistPath(root);
    const store = await CommandAllowlistStore.load(filePath);

    expect(path.dirname(filePath)).toBe(path.dirname(resolveAppConfigPath(root)));
    expect(store.listPrograms()).toEqual([]);
    await expect(store.addProgram("lark-cli")).resolves.toBe(true);
    await expect(store.addPrograms(["date", "lark-cli"])).resolves.toEqual(["date"]);
    await expect(store.addProgram("npm")).resolves.toBe(true);
    await expect(store.addProgram("lark-cli")).resolves.toBe(false);

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      version: 1,
      programs: ["lark-cli", "date", "npm"],
    });
    const reloaded = await CommandAllowlistStore.load(filePath);
    expect(reloaded.hasProgram("lark-cli")).toBe(true);
    expect(reloaded.hasProgram("date")).toBe(true);
    expect(reloaded.hasProgram("npm")).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects malformed files instead of silently approving commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-invalid-allowlist-"));
    const filePath = path.join(root, "allowlist.json");
    await writeFile(filePath, JSON.stringify({ version: 1, programs: "lark-cli" }), "utf8");

    await expect(loadCommandAllowlist(filePath)).rejects.toThrow("Invalid command allowlist");
  });
});
