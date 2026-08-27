/**
 * Atomic write helpers with EXDEV fallback.
 *
 * `fs.rename()` fails with EXDEV when the source and destination are on
 * different filesystems (e.g. /tmp on tmpfs and ~/.pi on ext4). On Windows
 * this can happen when TEMP and the target directory are on different drives.
 *
 * This helper tries rename first, then falls back to copy-then-unlink.
 */

import * as fs from "node:fs/promises";

export async function moveFileSafe(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EXDEV") throw err;
    // Cross-device: copy then unlink
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
}
