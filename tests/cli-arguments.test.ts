import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/arguments.js";

describe("CLI arguments", () => {
  it("defaults to streaming without a task or mode selector", () => {
    const options = parseCliArgs([]);
    expect(options.stream).toBe(true);
    expect(options).not.toHaveProperty("task");
    expect(options).not.toHaveProperty("interactive");
    expect(options).not.toHaveProperty("model");
  });

  it("can explicitly disable streaming while retaining other startup settings", () => {
    expect(parseCliArgs([
      "--workspace", "a project", "--max-steps", "8",
      "--skill-root", "local-skills", "--skill-root", "shared-skills",
      "--no-stream", "--debug", "--yes",
    ])).toMatchObject({
      workspace: "a project", maxSteps: 8,
      skillRoots: ["local-skills", "shared-skills"],
      stream: false, debug: true, autoApprove: true,
    });
    expect(parseCliArgs(["--no-stream", "--stream"]).stream).toBe(true);
  });

  it("rejects startup task text, including after the option terminator", () => {
    for (const args of [
      ["inspect the project"], ["--workspace", ".", "inspect", "files"],
      ["--", "inspect the project"], ["--", "--help"], [""],
    ]) {
      expect(() => parseCliArgs(args)).toThrow("enter your task at the agent> prompt");
    }
    expect(parseCliArgs(["--"]).stream).toBe(true);
  });

  it("rejects removed mode switches and missing option values", () => {
    for (const option of ["-i", "--interactive", "--non-interactive", "-m", "--model"]) {
      expect(() => parseCliArgs([option])).toThrow("Unknown option");
    }
    for (const option of ["--workspace", "--skill-root", "--max-steps"]) {
      expect(() => parseCliArgs([option])).toThrow("requires a value");
      expect(() => parseCliArgs([option, "--debug"])).toThrow("requires a value");
    }
  });
});
