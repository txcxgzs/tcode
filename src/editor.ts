import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { SandboxMode } from "./permissions.js";

export type EditorInput = {
  command: "view" | "create" | "str_replace" | "insert";
  path: string;
  file_text?: string;
  insert_line?: number;
  new_str?: string;
  old_str?: string;
  view_range?: number[];
};

// Mirrors @deepseek-ai/dsh-tool-str-replace-editor: the clipping marker tells
// the model how to narrow the next read instead of just reporting loss.
const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>';
const OUTPUT_LIMIT = 16_000;

function maybeTruncate(content: string, maxOutputChars = OUTPUT_LIMIT): string {
  return content.length <= maxOutputChars
    ? content
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

// DSH minimal mounts a bare local filesystem for this preset: no workspace
// fence, absolute paths required. Only read-only mode blocks mutations; the
// shell (not the editor) carries the host sandbox policy.
function resolveEditorPath(requested: string, mode: SandboxMode, writes: boolean) {
  if (!isAbsolute(requested)) throw new Error("path must be absolute");
  if (writes && mode === "read-only") throw new Error("File modification is disabled in read-only mode");
  return resolve(requested);
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function listDirectory(path: string): Promise<string> {
  const rows: string[] = [`d\t${path}`];
  const visit = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.filter((candidate) =>
      !candidate.name.startsWith(".")
      && candidate.name !== "node_modules"
      && candidate.name !== "__pycache__")) {
      const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
      const child = resolve(dir, entry.name);
      rows.push(`${type}\t${child}`);
      if (entry.isDirectory() && depth < 2) await visit(child, depth + 1);
    }
  };
  await visit(path, 1);
  rows.sort((left, right) => {
    const leftPath = left.slice(left.indexOf("\t") + 1);
    const rightPath = right.slice(right.indexOf("\t") + 1);
    return codepointCompare(leftPath, rightPath);
  });
  const listing = maybeTruncate(rows.join("\n") + "\n");
  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

function formatFileView(path: string, content: string, viewRange?: number[]): string {
  const allLines = content.split("\n");
  let lines = allLines;
  let initialLine = 1;
  let finalLine: number | undefined;
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
  if (viewRange !== undefined) {
    const [requestedInitialLine, requestedFinalLine] = viewRange;
    if (
      viewRange.length !== 2
      || requestedInitialLine === undefined
      || requestedFinalLine === undefined
      || !viewRange.every(Number.isInteger)
    ) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    initialLine = requestedInitialLine;
    finalLine = requestedFinalLine;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      );
    }
    if (finalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
      );
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
      );
    }
    lines = finalLine === -1
      ? allLines.slice(initialLine - 1)
      : allLines.slice(initialLine - 1, finalLine);
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
  }
  const numbered = lines
    .map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`)
    .join("\n");
  return maybeTruncate(`${prompt}:\n${numbered}\n`);
}

function requiredForCommand(
  value: string | undefined,
  parameter: string,
  command: string,
  allowEmpty = true,
): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
  }
  return value;
}

async function statExisting(path: string, command: "view" | "str_replace" | "insert") {
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
  if (info.isDirectory() && command !== "view")
    throw new Error(`The path ${path} is a directory and only the \`view\` command can be used on directories`);
  return info;
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const match = content.indexOf(search, offset);
    if (match < 0) return offsets;
    offsets.push(match);
    offset = match + search.length;
  }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") line += 1;
      cursor += 1;
    }
    return line;
  });
}

export async function strReplaceEditor(raw: Record<string, unknown>, mode: SandboxMode) {
  const input = raw as EditorInput;
  if (!["view", "create", "str_replace", "insert"].includes(input.command)) throw new Error("Invalid editor command");
  if (typeof input.path !== "string" || input.path.trim().length === 0) throw new Error("path must be a non-empty string");
  // Match DSH: required-parameter validation precedes path resolution.
  const fileText = input.command === "create"
    ? requiredForCommand(input.file_text, "file_text", "create")
    : undefined;
  if (input.command === "insert" && input.insert_line === undefined)
    throw new Error("Parameter `insert_line` is required for command: insert");
  const writes = input.command !== "view";
  const path = resolveEditorPath(input.path, mode, writes);

  if (input.command === "view") {
    const info = await statExisting(path, "view");
    if (info.isDirectory()) {
      if (input.view_range !== undefined)
        throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
      return listDirectory(path);
    }
    if (!info.isFile()) throw new Error(`cannot view "${path}": not a regular file or directory`);
    return formatFileView(path, await readFile(path, "utf8"), input.view_range);
  }
  if (input.command === "create") {
    if (await stat(path).catch(() => undefined))
      throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`);
    await mkdir(dirname(path), { recursive: true });
    // Defined whenever command === "create" (validated before path resolution).
    await writeFile(path, fileText!, "utf8");
    return `New file created successfully at: ${path}`;
  }
  if (input.command === "str_replace") {
    const oldValue = requiredForCommand(input.old_str, "old_str", "str_replace", false);
    const newValue = input.new_str ?? "";
    await statExisting(path, "str_replace");
    const original = await readFile(path, "utf8");
    const offsets = matchOffsets(original, oldValue);
    const offset = offsets[0];
    if (offset === undefined)
      throw new Error(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${path}.`);
    if (offsets.length > 1) {
      const lines = lineNumbersAt(original, offsets);
      throw new Error(`No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(", ")}]. Please ensure it is unique`);
    }
    await writeFile(path, `${original.slice(0, offset)}${newValue}${original.slice(offset + oldValue.length)}`, "utf8");
    return `The file ${path} has been edited successfully.`;
  }
  // Guarded by the required check above the path resolution.
  const insertLine = input.insert_line!;
  const value = requiredForCommand(input.new_str, "new_str", "insert");
  await statExisting(path, "insert");
  const original = await readFile(path, "utf8");
  const lines = original.split("\n");
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    throw new Error(
      `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    );
  }
  const after = [
    ...lines.slice(0, insertLine),
    ...value.split("\n"),
    ...lines.slice(insertLine),
  ].join("\n");
  await writeFile(path, after, "utf8");
  return `The file ${path} has been edited successfully.`;
}
