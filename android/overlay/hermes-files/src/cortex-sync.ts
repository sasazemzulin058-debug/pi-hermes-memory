/**
 * Cortex sync helper for pi-hermes-memory.
 * Writes durable memory facts into the Cortex Obsidian vault as Markdown pages.
 */

import * as fs from "node:fs";
import * as path from "node:path";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function formatFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else if (typeof value === "string") {
      lines.push(`${key}: "${value}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export function syncToCortex(
  vaultPath: string,
  fact: string,
  target: "memory" | "user" | "failure",
  domain?: string,
): { pagePath: string; isNew: boolean; concept: string } {
  if (!fs.existsSync(vaultPath)) {
    const concept = domain || "general";
    const type = target === "user" ? "person" : "concept";
    const pagePath = path.join(vaultPath, "20-Wiki", `${type}s`, `${slugify(concept)}.md`);
    return { pagePath, isNew: false, concept };
  }

  const type = target === "user" ? "person" : "concept";
  const dir = path.join(vaultPath, "20-Wiki", `${type}s`);
  fs.mkdirSync(dir, { recursive: true });

  const concept = domain || "general";
  const pagePath = path.join(dir, `${slugify(concept)}.md`);
  const date = today();
  const note = `## Memory note (${date})\n\n${fact}\n\nConfidence: medium`;
  const isNew = !fs.existsSync(pagePath);

  if (isNew) {
    const fm = {
      type,
      created: date,
      updated: date,
      source: "pi-hermes-memory",
      tags: [type, "cortex"],
      confidence: "medium",
      status: "seedling",
    };
    fs.writeFileSync(
      pagePath,
      `${formatFrontmatter(fm)}\n\n# ${concept}\n\n${note}`,
      "utf-8",
    );
  } else {
    const existing = fs.readFileSync(pagePath, "utf-8");
    const updated = `${existing}\n\n${note}`;
    fs.writeFileSync(pagePath, updated, "utf-8");
  }

  return { pagePath, isNew, concept };
}