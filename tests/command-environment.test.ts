import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandEnvironment } from "../src/tools/command-environment.js";

const ripgrepRoot = fileURLToPath(new URL("../vendor/ripgrep/", import.meta.url));

describe("bundled command environment", () => {
  it.each(["x64", "arm64"])("selects the macOS %s binary and preserves the host environment", (architecture) => {
    const original = { PATH: "/usr/bin:/bin", EXAMPLE_SECRET: "inherited" };
    const env = commandEnvironment(original, "darwin", architecture);

    expect(env.PATH).toBe(`${path.join(ripgrepRoot, `darwin-${architecture}`)}:/usr/bin:/bin`);
    expect(env.EXAMPLE_SECRET).toBe("inherited");
    expect(original.PATH).toBe("/usr/bin:/bin");
  });

  it.each(["x64", "arm64"])("selects the Windows %s binary and merges PATH keys for spawn", (architecture) => {
    const original = { Path: "C:\\Windows\\System32", PATH: "C:\\tools", EXAMPLE_TOKEN: "inherited" };
    const env = commandEnvironment(original, "win32", architecture);

    expect(env.PATH).toBe(`${path.join(ripgrepRoot, `win32-${architecture}`)};C:\\tools`);
    expect(env).not.toHaveProperty("Path");
    expect(env.EXAMPLE_TOKEN).toBe("inherited");
    expect(original.Path).toBe("C:\\Windows\\System32");
    expect(commandEnvironment({ Path: "C:\\Windows" }, "win32", architecture).Path)
      .toBe(`${path.join(ripgrepRoot, `win32-${architecture}`)};C:\\Windows`);
  });

  it("works without a system PATH and does not duplicate the bundled directory", () => {
    const env = commandEnvironment({}, "darwin", "arm64");
    expect(env.PATH).toBe(path.join(ripgrepRoot, "darwin-arm64"));
    expect(commandEnvironment(env, "darwin", "arm64")).toEqual(env);
  });

  it("keeps the system environment on platforms without a bundled binary", () => {
    const env = { PATH: "/usr/bin", TEST_TOKEN: "inherited" };
    expect(commandEnvironment(env, "linux", "x64")).toEqual(env);
    expect(commandEnvironment(env, "win32", "ia32")).toEqual(env);
  });

  it.each([
    ["darwin-x64", "rg", "cffaedfe", 0x01000007],
    ["darwin-arm64", "rg", "cffaedfe", 0x0100000c],
    ["win32-x64", "rg.exe", "4d5a", 0x8664],
    ["win32-arm64", "rg.exe", "4d5a", 0xaa64],
  ] as const)("ships a native binary for %s", async (target, name, signature, cpu) => {
    const binaryPath = path.join(ripgrepRoot, target, name);
    const bytes = await readFile(binaryPath);
    expect(bytes.subarray(0, signature.length / 2).toString("hex")).toBe(signature);
    if (target.startsWith("darwin")) {
      expect(bytes.readUInt32LE(4)).toBe(cpu);
      if (process.platform !== "win32") await access(binaryPath, constants.X_OK);
    } else {
      const peOffset = bytes.readUInt32LE(0x3c);
      expect(bytes.subarray(peOffset, peOffset + 4).toString("hex")).toBe("50450000");
      expect(bytes.readUInt16LE(peOffset + 4)).toBe(cpu);
    }
  });
});
