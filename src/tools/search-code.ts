import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  createWorkspacePathResolver,
  toWorkspaceRelative,
} from "../policy/path-policy.js";
import { walkFilesWithMetadata, type WalkLimitName } from "./files.js";
import type { AgentTool } from "./types.js";

const MAX_DISCOVERED_FILES = 5_000;
const MAX_DISCOVERED_DIRECTORIES = 5_000;
const MAX_DISCOVERED_ENTRIES = 20_000;
const MAX_CONTEXT_LINES = 5;
const MAX_LINE_CHARS = 500;
const MAX_SEARCH_FILE_BYTES = 2_000_000;
const MAX_TOTAL_SEARCH_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_RESULT_CHARS = 12_000;

const inputSchema = z.object({
  query: z.string().min(1).max(500),
  path: z.string().min(1),
  maxResults: z.number().int().min(1).max(200),
  ignoreCase: z.boolean().nullable().default(false),
  glob: z.string().max(300).nullable().default(null).transform(normalizeGlob),
  context: z.number().int().min(0).max(MAX_CONTEXT_LINES).nullable().default(0),
}).strict();

type SearchCodeInput = z.input<typeof inputSchema>;

interface ContextLine {
  line: number;
  text: string;
}

interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  lineTruncated?: boolean;
  contextTruncated?: boolean;
  before?: ContextLine[];
  after?: ContextLine[];
}

interface ScanCounters {
  filesDiscovered: number;
  filesSearched: number;
  directoriesScanned: number;
  entriesScanned: number;
  bytesRead: number;
  unreadableDirectories: number;
  ignoredPaths: number;
  skippedByGlob: number;
  skippedByPathPolicy: number;
  skippedBySize: number;
  skippedBinaryFiles: number;
  unreadableFiles: number;
  matchesFound: number;
}

export function createSearchCodeTool(): AgentTool<SearchCodeInput> {
  return {
    risk: "read",
    executionMode: "parallel",
    definition: {
      type: "function",
      name: "search_code",
      description:
        "Search one workspace UTF-8 text file or UTF-8 text files under a directory for a literal string. Supports optional case-insensitive matching, a path glob, and nearby context lines. Each file is limited to 2000000 bytes, one search reads at most 64 MiB, and the structured result is limited to 12000 characters; incomplete scans report their reasons.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file or directory to search.",
          },
          maxResults: { type: "integer", minimum: 1, maximum: 200 },
          ignoreCase: {
            type: ["boolean", "null"],
            description: "Set true for case-insensitive content matching; null defaults to false.",
          },
          glob: {
            type: ["string", "null"],
            maxLength: 300,
            description:
              "Optional workspace-relative path glob using *, **, and ?. Empty string or null disables the filter; a pattern without '/' matches file names.",
          },
          context: {
            type: ["integer", "null"],
            minimum: 0,
            maximum: MAX_CONTEXT_LINES,
            description: "Number of lines before and after each match; null defaults to 0.",
          },
        },
        required: ["query", "path", "maxResults", "ignoreCase", "glob", "context"],
        additionalProperties: false,
      },
    },
    parse: (input) => inputSchema.parse(input),
    async execute(input, context) {
      const ignoreCase = input.ignoreCase ?? false;
      const contextLines = input.context ?? 0;
      const normalizedGlob = normalizeGlob(input.glob);
      // Compile the path filter before touching the filesystem, so malformed
      // search options fail before walking a large workspace.
      const findLineMatch = createLineMatcher(input.query, ignoreCase);
      const pathMatches = normalizedGlob === null
        ? undefined
        : createGlobMatcher(normalizedGlob);

      const resolver = await createWorkspacePathResolver(context.workspaceRoot);
      const target = await resolver.resolveExisting(input.path);
      const metadata = await stat(target);
      const isExplicitFile = metadata.isFile();
      let files: string[];
      let discoveryLimitReached: WalkLimitName | null = null;
      let ignoredPaths = 0;
      let directoriesScanned = 0;
      let entriesScanned = 0;
      let unreadableDirectories = 0;
      let filteredByGlob = 0;

      if (isExplicitFile) {
        files = [target];
      } else if (metadata.isDirectory()) {
        const discovered = await walkFilesWithMetadata(target, {
          maxFiles: MAX_DISCOVERED_FILES,
          maxDirectories: MAX_DISCOVERED_DIRECTORIES,
          maxEntries: MAX_DISCOVERED_ENTRIES,
          includeFile: pathMatches
            ? (file) => pathMatches(toWorkspaceRelative(context.workspaceRoot, file))
            : undefined,
        });
        files = discovered.files;
        discoveryLimitReached = discovered.limitReached;
        ignoredPaths = discovered.ignoredPaths;
        directoriesScanned = discovered.directoriesScanned;
        entriesScanned = discovered.entriesScanned;
        unreadableDirectories = discovered.unreadableDirectories;
        filteredByGlob = discovered.filteredFiles;
      } else {
        throw new Error("search_code only accepts files or directories.");
      }

      const matches: SearchMatch[] = [];
      const counters: ScanCounters = {
        filesDiscovered: files.length + filteredByGlob,
        filesSearched: 0,
        directoriesScanned,
        entriesScanned,
        bytesRead: 0,
        unreadableDirectories,
        ignoredPaths,
        skippedByGlob: filteredByGlob,
        skippedByPathPolicy: 0,
        skippedBySize: 0,
        skippedBinaryFiles: 0,
        unreadableFiles: 0,
        matchesFound: 0,
      };
      let totalByteLimitReached = false;

      for (const file of files) {
        const relativePath = toWorkspaceRelative(context.workspaceRoot, file);
        let safeFile: string;

        // Directory walking deliberately does not make a discovered child safe.
        // Resolve every candidate again immediately before filtering and reading
        // it. This reapplies sensitive-path and canonical symlink checks, so an
        // allowed parent directory cannot make credentials.json or an escaping
        // link readable.
        try {
          safeFile = await resolver.resolveExisting(relativePath);
        } catch {
          counters.skippedByPathPolicy += 1;
          continue;
        }

        if (pathMatches !== undefined && !pathMatches(relativePath)) {
          counters.skippedByGlob += 1;
          continue;
        }

        let candidateMetadata: Awaited<ReturnType<typeof stat>>;
        try {
          candidateMetadata = await stat(safeFile);
        } catch {
          counters.unreadableFiles += 1;
          continue;
        }
        if (!candidateMetadata.isFile()) {
          counters.unreadableFiles += 1;
          continue;
        }
        if (candidateMetadata.size > MAX_SEARCH_FILE_BYTES) {
          if (isExplicitFile) {
            throw new Error(`Search file exceeds ${MAX_SEARCH_FILE_BYTES} bytes.`);
          }
          counters.skippedBySize += 1;
          continue;
        }
        if (counters.bytesRead + candidateMetadata.size > MAX_TOTAL_SEARCH_BYTES) {
          totalByteLimitReached = true;
          break;
        }

        let data: Buffer;
        try {
          data = await readFile(safeFile);
        } catch {
          counters.unreadableFiles += 1;
          continue;
        }
        counters.bytesRead += data.length;
        let text: string;
        try {
          if (data.includes(0)) throw new Error("NUL byte");
          text = new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          if (isExplicitFile) {
            throw new Error("Binary or non-UTF-8 files are not supported.");
          }
          counters.skippedBinaryFiles += 1;
          continue;
        }
        counters.filesSearched += 1;

        const lines = text.split("\n").map(trimTrailingCarriageReturn);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const lineMatch = findLineMatch(line);
          if (!lineMatch) continue;
          counters.matchesFound += 1;
          const renderedLine = renderMatchedLine(line, lineMatch.index);

          const match: SearchMatch = {
            path: relativePath,
            line: index + 1,
            column: lineMatch.index + 1,
            text: renderedLine.text,
            ...(renderedLine.truncated ? { lineTruncated: true } : {}),
          };
          if (contextLines > 0) {
            match.before = selectContext(lines, Math.max(0, index - contextLines), index);
            match.after = selectContext(lines, index + 1, Math.min(lines.length, index + contextLines + 1));
          }
          matches.push(match);

          // Reserve space for the output-budget reason on every candidate.
          // This keeps the final result structured instead of relying on the
          // AgentRunner's generic tool-output truncation.
          const projectedResult = buildSearchResult(
            matches,
            false,
            counters,
            discoveryLimitReached,
            totalByteLimitReached,
            false,
            true,
          );
          if (serializedSearchResultLength(projectedResult) > MAX_SEARCH_RESULT_CHARS) {
            matches.pop();
            if (matches.length === 0) {
              const { before, after, ...compactMatch } = match;
              matches.push({
                ...compactMatch,
                ...((before || after) ? { contextTruncated: true } : {}),
              });
            }
            return finalizeSearchResult(
              matches,
              false,
              counters,
              discoveryLimitReached,
              totalByteLimitReached,
              false,
              true,
            );
          }

          if (matches.length >= input.maxResults) {
            return finalizeSearchResult(
              matches,
              true,
              counters,
              discoveryLimitReached,
              totalByteLimitReached,
              true,
              false,
            );
          }
        }
      }

      return finalizeSearchResult(
        matches,
        false,
        counters,
        discoveryLimitReached,
        totalByteLimitReached,
        false,
        false,
      );
    },
  };
}

function normalizeGlob(glob: string | null | undefined): string | null {
  return glob === undefined || glob === null || glob.trim() === "" ? null : glob;
}

function createLineMatcher(
  query: string,
  ignoreCase: boolean,
): (line: string) => { index: number } | null {
  if (ignoreCase) {
    const expression = new RegExp(escapeRegularExpression(query), "iu");
    return (line) => {
      const match = expression.exec(line);
      return match ? { index: match.index } : null;
    };
  }
  return (line) => {
    const index = line.indexOf(query);
    return index === -1 ? null : { index };
  };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function createGlobMatcher(glob: string): (relativePath: string) => boolean {
  const normalizedGlob = glob.replaceAll("\\", "/").replace(/^\.\//u, "");
  const matchFileNameOnly = !normalizedGlob.includes("/");
  const tokens = tokenizeGlob(normalizedGlob);
  return (relativePath) => {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    const candidate = matchFileNameOnly ? path.posix.basename(normalizedPath) : normalizedPath;
    return matchGlob(tokens, candidate);
  };
}

type GlobToken =
  | { type: "literal"; value: string }
  | { type: "single" }
  | { type: "star" }
  | { type: "globstar" }
  | { type: "globstar_directory" };

function tokenizeGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  const characters = Array.from(glob);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (character === "*") {
      if (characters[index + 1] === "*") {
        const beginsPathSegment = index === 0 || characters[index - 1] === "/";
        const characterAfterPair = characters[index + 2];
        index += 1;
        if (beginsPathSegment && characterAfterPair === "/") {
          index += 1;
          tokens.push({ type: "globstar_directory" });
        } else if (beginsPathSegment && characterAfterPair === undefined) {
          tokens.push({ type: "globstar" });
        } else {
          // Globstar is special only as a complete path segment. Embedded '**'
          // has the same non-separator semantics as '*'.
          tokens.push({ type: "star" });
        }
      } else {
        tokens.push({ type: "star" });
      }
      continue;
    }
    if (character === "?") {
      tokens.push({ type: "single" });
      continue;
    }
    tokens.push({ type: "literal", value: character });
  }
  return tokens;
}

function matchGlob(tokens: GlobToken[], candidate: string): boolean {
  const characters = Array.from(candidate);
  let reachable = new Uint8Array(characters.length + 1);
  let next = new Uint8Array(characters.length + 1);
  reachable[0] = 1;

  for (const token of tokens) {
    next.fill(0);
    if (token.type === "literal" || token.type === "single") {
      for (let index = 0; index < characters.length; index += 1) {
        if (!reachable[index]) continue;
        const character = characters[index] ?? "";
        if (token.type === "literal" ? character === token.value : character !== "/") {
          next[index + 1] = 1;
        }
      }
    } else if (token.type === "star") {
      for (let index = 0; index <= characters.length; index += 1) {
        if (reachable[index]) next[index] = 1;
        if (index < characters.length && next[index] && characters[index] !== "/") {
          next[index + 1] = 1;
        }
      }
    } else if (token.type === "globstar") {
      let canReach = false;
      for (let index = 0; index <= characters.length; index += 1) {
        canReach ||= reachable[index] === 1;
        next[index] = canReach ? 1 : 0;
      }
    } else {
      let canReach = false;
      for (let index = 0; index <= characters.length; index += 1) {
        canReach ||= reachable[index] === 1;
        if (reachable[index]) next[index] = 1;
        if (index < characters.length && canReach && characters[index] === "/") {
          next[index + 1] = 1;
        }
      }
    }
    [reachable, next] = [next, reachable];
  }

  return reachable[characters.length] === 1;
}

function selectContext(lines: string[], start: number, end: number): ContextLine[] {
  const selected: ContextLine[] = [];
  for (let index = start; index < end; index += 1) {
    selected.push({
      line: index + 1,
      text: truncateLine(lines[index] ?? ""),
    });
  }
  return selected;
}

function trimTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

function renderMatchedLine(line: string, matchIndex: number): { text: string; truncated: boolean } {
  if (line.length <= MAX_LINE_CHARS) return { text: line, truncated: false };
  const visibleCharacters = MAX_LINE_CHARS - 2;
  let start = Math.max(0, matchIndex - Math.floor(visibleCharacters / 3));
  start = Math.min(start, line.length - visibleCharacters);
  const end = start + visibleCharacters;
  return {
    text: `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`,
    truncated: true,
  };
}

function buildSearchResult(
  matches: SearchMatch[],
  truncated: boolean,
  counters: ScanCounters,
  discoveryLimitReached: WalkLimitName | null,
  totalByteLimitReached: boolean,
  resultLimitReached: boolean,
  outputBudgetReached: boolean,
): SearchResult {
  const reasons: string[] = [];
  if (discoveryLimitReached) reasons.push(`discovery_${discoveryLimitReached}_reached`);
  if (totalByteLimitReached) reasons.push("total_byte_limit_reached");
  if (resultLimitReached) reasons.push("result_limit_reached");
  if (outputBudgetReached) reasons.push("output_budget_reached");
  if (counters.ignoredPaths > 0) reasons.push("ignored_paths");
  if (counters.unreadableDirectories > 0) reasons.push("unreadable_directories");
  if (counters.skippedByPathPolicy > 0) reasons.push("path_policy");
  if (counters.skippedBySize > 0) reasons.push("file_size_limit");
  if (counters.skippedBinaryFiles > 0) reasons.push("binary_files");
  if (counters.unreadableFiles > 0) reasons.push("unreadable_files");

  return {
    matches,
    truncated: truncated
      || discoveryLimitReached !== null
      || totalByteLimitReached
      || outputBudgetReached,
    scan: {
      ...counters,
      incomplete: reasons.length > 0,
      reasons,
    },
  };
}

interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  scan: ScanCounters & { incomplete: boolean; reasons: string[] };
}

function serializedSearchResultLength(result: SearchResult): number {
  return JSON.stringify(result).length;
}

function finalizeSearchResult(
  matches: SearchMatch[],
  truncated: boolean,
  counters: ScanCounters,
  discoveryLimitReached: WalkLimitName | null,
  totalByteLimitReached: boolean,
  resultLimitReached: boolean,
  outputBudgetReached: boolean,
): SearchResult {
  let budgetReached = outputBudgetReached;
  let result = buildSearchResult(
    matches,
    truncated,
    counters,
    discoveryLimitReached,
    totalByteLimitReached,
    resultLimitReached,
    budgetReached,
  );

  while (serializedSearchResultLength(result) > MAX_SEARCH_RESULT_CHARS && matches.length > 0) {
    matches.pop();
    budgetReached = true;
    result = buildSearchResult(
      matches,
      truncated,
      counters,
      discoveryLimitReached,
      totalByteLimitReached,
      resultLimitReached,
      budgetReached,
    );
  }

  if (serializedSearchResultLength(result) > MAX_SEARCH_RESULT_CHARS) {
    throw new Error("Search metadata exceeds the configured output budget.");
  }
  return result;
}
