const DESTRUCTIVE_PROGRAMS = new Set([
  "dd",
  "fdisk",
  "halt",
  "kill",
  "killall",
  "mkfs",
  "pkill",
  "poweroff",
  "reboot",
  "rm",
  "rmdir",
  "shred",
  "shutdown",
  "srm",
  "su",
  "sudo",
  "unlink",
]);

const SHELL_PROGRAMS = new Set(["bash", "csh", "dash", "fish", "ksh", "sh", "zsh"]);
const INLINE_CODE_PROGRAMS = new Set(["node", "perl", "php", "python", "python2", "python3", "ruby"]);
const COMMAND_WRAPPERS = new Set(["env", "nice", "nohup", "xargs"]);

export function assertCommandAllowed(program: string, args: string[]): void {
  const executable = executableName(program);
  const normalizedArgs = args.map((argument) => argument.toLowerCase());

  if (DESTRUCTIVE_PROGRAMS.has(executable) || executable.startsWith("mkfs.")) {
    throw blocked(program, `the '${executable}' program is destructive or privileged`);
  }

  if (executable === "git") {
    if (normalizedArgs.includes("clean")) {
      throw blocked(program, "git clean can permanently delete untracked files");
    }
    if (normalizedArgs.includes("reset") && normalizedArgs.some((argument) => argument.startsWith("--hard"))) {
      throw blocked(program, "git reset --hard can discard workspace changes");
    }
    if (normalizedArgs.includes("checkout") && normalizedArgs.includes("--")) {
      throw blocked(program, "git checkout -- can discard workspace changes");
    }
    if (normalizedArgs.includes("restore")) {
      throw blocked(program, "git restore can discard workspace changes");
    }
  }

  if (executable === "find" && normalizedArgs.includes("-delete")) {
    throw blocked(program, "find -delete can recursively delete files");
  }

  if (SHELL_PROGRAMS.has(executable) && normalizedArgs.some(isShellCommandFlag)) {
    throw blocked(program, "inline shell scripts bypass structured command validation");
  }

  if (executable === "cmd" && normalizedArgs.includes("/c")) {
    throw blocked(program, "cmd /c bypasses structured command validation");
  }

  if ((executable === "powershell" || executable === "pwsh") && normalizedArgs.some(isPowerShellCommandFlag)) {
    throw blocked(program, "inline PowerShell bypasses structured command validation");
  }

  if (INLINE_CODE_PROGRAMS.has(executable) && normalizedArgs.some(isInlineCodeFlag)) {
    throw blocked(program, "inline interpreter code bypasses structured command validation");
  }

  if (
    COMMAND_WRAPPERS.has(executable) &&
    normalizedArgs.some((argument) => DESTRUCTIVE_PROGRAMS.has(executableName(argument)))
  ) {
    throw blocked(program, "arguments attempt to invoke a destructive program indirectly");
  }
}

export function formatCommand(program: string, args: string[]): string {
  return [program, ...args].map(quoteForDisplay).join(" ");
}

function executableName(program: string): string {
  const basename = program.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return basename.replace(/\.(?:bat|cmd|exe)$/u, "");
}

function isShellCommandFlag(argument: string): boolean {
  return argument === "-c" || argument === "--command";
}

function isPowerShellCommandFlag(argument: string): boolean {
  return argument === "-c" || argument === "-command" || argument === "--command";
}

function isInlineCodeFlag(argument: string): boolean {
  return argument === "-c" || argument === "-e" || argument === "-p" || argument === "--eval" || argument === "--print";
}

function quoteForDisplay(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value) ? value : JSON.stringify(value);
}

function blocked(program: string, reason: string): Error {
  return new Error(`Command blocked by host policy (${program}): ${reason}.`);
}
