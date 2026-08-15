import { spawn } from "node:child_process";
import process from "node:process";

interface OpenCommand {
  program: string;
  args: string[];
}

export function defaultBrowserCommand(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): OpenCommand {
  if (platform === "win32") return { program: "explorer.exe", args: [filePath] };
  if (platform === "darwin") return { program: "open", args: [filePath] };
  return { program: "xdg-open", args: [filePath] };
}

export async function openInDefaultBrowser(filePath: string): Promise<void> {
  const command = defaultBrowserCommand(filePath);
  const child = spawn(command.program, command.args, {
    shell: false,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}
