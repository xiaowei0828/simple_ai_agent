import path from "node:path";
import { fileURLToPath } from "node:url";

const bundledPlatforms = new Set(["darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]);
// src/tools and dist/tools have the same depth relative to the package root.
const ripgrepRoot = fileURLToPath(new URL("../../vendor/ripgrep/", import.meta.url));

export function commandEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): NodeJS.ProcessEnv {
  const env = { ...environment };
  const target = `${platform}-${architecture}`;
  if (!bundledPlatforms.has(target)) return env;

  const binDir = path.join(ripgrepRoot, target);
  const separator = platform === "win32" ? ";" : ":";
  // Windows treats PATH names case-insensitively; pass a single key to spawn.
  const pathKeys = platform === "win32"
    ? Object.keys(env).filter((key) => key.toLowerCase() === "path").sort()
    : ["PATH"];
  const pathKey = pathKeys[0] ?? "PATH";
  const currentPath = env[pathKey];
  for (const key of pathKeys) delete env[key];
  const entries = currentPath?.split(separator).filter((entry) => entry !== binDir) ?? [];
  env[pathKey] = [binDir, ...entries].join(separator);
  return env;
}
