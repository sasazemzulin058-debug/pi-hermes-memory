import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { moveFileSafe } from "../../src/store/atomic-write.js";

describe("moveFileSafe", () => {
  it("moves a file with rename when possible", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "move-test-"));
    const src = path.join(tmpDir, "a.txt");
    const dst = path.join(tmpDir, "b.txt");
    await fs.writeFile(src, "hello", "utf-8");

    await moveFileSafe(src, dst);

    const content = await fs.readFile(dst, "utf-8");
    assert.strictEqual(content, "hello");
    assert.ok(!(await fileExists(src)), "source should no longer exist");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("overwrites existing destination", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "move-test-"));
    const src = path.join(tmpDir, "a.txt");
    const dst = path.join(tmpDir, "b.txt");
    await fs.writeFile(src, "new", "utf-8");
    await fs.writeFile(dst, "old", "utf-8");

    await moveFileSafe(src, dst);

    const content = await fs.readFile(dst, "utf-8");
    assert.strictEqual(content, "new");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
