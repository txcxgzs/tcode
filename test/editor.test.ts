import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strReplaceEditor } from "../src/editor.js";

let root = "";
let outside = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
});

describe("str_replace_editor", () => {
  it("creates, views, uniquely replaces, and inserts", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-editor-"));
    const path = join(root, "sample.txt");
    await strReplaceEditor({ command: "create", path, file_text: "one\ntwo\n" }, "workspace-write");
    const view = await strReplaceEditor({ command: "view", path }, "workspace-write");
    expect(view).toContain("Here's the content of");
    expect(view).toContain("total of 3 lines");
    expect(view).toContain("1  one");
    await strReplaceEditor({ command: "str_replace", path, old_str: "two", new_str: "second" }, "workspace-write");
    await strReplaceEditor({ command: "insert", path, insert_line: 1, new_str: "middle" }, "workspace-write");
    expect(await readFile(path, "utf8")).toBe("one\nmiddle\nsecond\n");
  });

  it("lists directories up to 2 levels with type prefixes", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-editor-ls-"));
    const nested = join(root, "pkg", "inner");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "pkg", "file.ts"), "x");
    const listing = await strReplaceEditor({ command: "view", path: root }, "workspace-write");
    expect(listing).toContain("Here're the files and directories up to 2 levels deep");
    expect(listing).toContain(`d\t${root}`);
    expect(listing).toContain(`f\t${join(root, "pkg", "file.ts")}`);
    expect(listing).toContain(`d\t${nested}`);
  });

  it("validates view_range with actionable errors", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-editor-range-"));
    const path = join(root, "sample.txt");
    await writeFile(path, "a\nb\nc\n");
    const ranged = await strReplaceEditor({ command: "view", path, view_range: [2, 3] }, "workspace-write");
    expect(ranged).toContain("with view_range=[2, 3]");
    expect(ranged).toContain("2  b");
    expect(ranged).not.toContain("1  a");
    await expect(strReplaceEditor({ command: "view", path, view_range: [5, 9] }, "workspace-write"))
      .rejects.toThrow(/first element `5` should be within the range of lines of the file: \[1, 4\]/);
    await expect(strReplaceEditor({ command: "view", path, view_range: [1] }, "workspace-write"))
      .rejects.toThrow("Invalid `view_range`. It should be a list of two integers.");
  });

  it("rejects ambiguous replacement, missing matches, and read-only writes", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-editor-dup-"));
    const path = join(root, "sample.txt");
    await writeFile(path, "same\nsame\n");
    await expect(strReplaceEditor({ command: "str_replace", path, old_str: "same", new_str: "x" }, "workspace-write"))
      .rejects.toThrow("Please ensure it is unique");
    await expect(strReplaceEditor({ command: "str_replace", path, old_str: "absent", new_str: "x" }, "workspace-write"))
      .rejects.toThrow("did not appear verbatim");
    await expect(strReplaceEditor({ command: "create", path: join(root, "blocked.txt"), file_text: "x" }, "read-only")).rejects.toThrow("read-only");
  });

  it("rejects relative paths", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-editor-rel-"));
    await expect(strReplaceEditor({ command: "view", path: "relative/file.txt" }, "workspace-write"))
      .rejects.toThrow("path must be absolute");
  });

  it("operates on the bare local filesystem without a workspace fence (DSH minimal)", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-editor-inside-"));
    outside = await mkdtemp(join(tmpdir(), "tcode-editor-outside-"));
    const outsideFile = join(outside, "external.txt");
    await strReplaceEditor({ command: "create", path: outsideFile, file_text: "anywhere\n" }, "workspace-write");
    expect(await readFile(outsideFile, "utf8")).toBe("anywhere\n");
    expect(await strReplaceEditor({ command: "view", path: outsideFile }, "workspace-write")).toContain("1  anywhere");
    // read-only still reads everywhere but blocks every mutation.
    expect(await strReplaceEditor({ command: "view", path: outsideFile }, "read-only")).toContain("1  anywhere");
    await expect(strReplaceEditor({ command: "create", path: join(outside, "blocked.txt"), file_text: "x" }, "read-only"))
      .rejects.toThrow("read-only");
  });
});
