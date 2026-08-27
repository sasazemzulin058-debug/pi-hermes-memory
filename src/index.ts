// Re-export non-Pi runtime factory for OMP `memory.backend: hermes`
// Keeps Pi default extension intact; OMP imports this named export without
// triggering Pi tool/command registration.
export { createHermesMemoryBackend } from "./hermes-runtime.js";
export type {
  HermesBackendRuntime,
  HermesBackendRuntimeOptions,
  HermesBackendStatus,
  HermesBackendSearchOptions,
  HermesBackendSearchResult,
  HermesBackendSearchItem,
  HermesBackendSaveInput,
  HermesBackendSaveResult,
  HermesExec,
} from "./hermes-runtime.js";
/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Background Learning Loop — auto-saves notable facts every N turns
 * 3. Session-End Flush — saves memories before compaction/shutdown
 * 4. Auto-Consolidation — merges memory when full instead of erroring
 * 5. Correction Detection — immediate save on user corrections
 * 6. Procedural Skills — SKILL.md files for reusable procedures
 * 7. Tool-Call-Aware Nudge — review triggers on tool call count too
 * 8. /memory-insights — shows what's stored
 * 9. /memory-skills — lists procedural skills
 * 10. /memory-consolidate — manual consolidation trigger
 * 11. /memory-interview — onboarding interview to pre-fill user profile
 * 12. /memory-switch-project — list project memories
 * 13. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 14. Memory Aging — entry timestamps guide consolidation
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "./store/memory-store.js";
import { SkillStore } from "./store/skill-store.js";
import { DatabaseManager } from "./store/db.js";
import { indexSession } from "./store/session-indexer.js";
import { parseSessionFile } from "./store/session-parser.js";
import { registerMemoryTool } from "./tools/memory-tool.js";
import { registerSkillTool } from "./tools/skill-tool.js";
import { registerSessionSearchTool } from "./tools/session-search-tool.js";
import { registerMemorySearchTool } from "./tools/memory-search-tool.js";
import { setupBackgroundReview } from "./handlers/background-review.js";
import { setupSessionFlush } from "./handlers/session-flush.js";
import { registerInsightsCommand } from "./handlers/insights.js";
import { triggerConsolidation, registerConsolidateCommand } from "./handlers/auto-consolidate.js";
import { setupCorrectionDetector } from "./handlers/correction-detector.js";
import { setupSkillAutoTrigger } from "./handlers/skill-auto-trigger.js";
import { registerSkillsCommand } from "./handlers/skills-command.js";
import { registerInterviewCommand } from "./handlers/interview.js";
import { registerSwitchProjectCommand } from "./handlers/switch-project.js";
import { registerIndexSessionsCommand } from "./handlers/index-sessions.js";
import { registerLearnMemoryCommand } from "./handlers/learn-memory.js";
import { loadConfig } from "./config.js";
import { detectProject } from "./project.js";

// ─── Domain detection helpers ───

function detectDomainFromContext(text: string, domains?: string[]): string | undefined {
  if (!domains || domains.length === 0) return undefined;
  const lower = text.toLowerCase();
  for (const d of domains) {
    if (lower.includes(d.toLowerCase())) return d;
  }
  return undefined;
}

function extractKeywordsFromContext(...texts: (string | null)[]): string[] {
  const combined = texts.filter(Boolean).join(" ");
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "need", "to", "of",
    "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
    "during", "before", "after", "above", "below", "between", "under",
    "again", "further", "then", "once", "here", "there", "when", "where",
    "why", "how", "all", "any", "both", "each", "few", "more", "most",
    "other", "some", "such", "no", "nor", "not", "only", "own", "same",
    "so", "than", "too", "very", "just", "and", "but", "if", "or",
    "because", "until", "while",
  ]);
  return [...new Set(combined.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !stopWords.has(w)))];
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const globalDir = config.memoryDir ?? path.join(os.homedir(), ".pi", "agent", "memory");
  const store = new MemoryStore(config);
  const skillStore = new SkillStore(path.join(globalDir, "skills"));
  const dbManager = new DatabaseManager(globalDir);

  // Detect project from cwd using shared helper
  const project = detectProject();

  // Project-scoped store: ~/.pi/agent/<project_name>/
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir ? new MemoryStore(projectConfig) : null;
  const projectName = project.name ?? "";

  // ── 1. Load memory from disk + show startup status ──
  pi.on("session_start", async (_event, ctx) => {
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();

    const memoryChars = store.getMemoryChars();
    const userChars = store.getUserChars();
    const memoryTokens = Math.ceil(memoryChars / 4);
    const userTokens = Math.ceil(userChars / 4);
    const totalTokens = memoryTokens + userTokens;

    if (config.autoInject === false) {
      ctx.ui?.notify?.(
        `🧠 Memory loaded · ${totalTokens} tokens on disk · Injection OFF · Use memory_search or /memory-insights`,
        "info"
      );
    } else {
      ctx.ui?.notify?.(
        `🧠 Memory injected · ${totalTokens} tokens · Use /memory-insights for details`,
        "info"
      );
    }
  });

  // ── 2. Inject ranked memory + skill index + project memory into system prompt (optional) ───
  if (config.autoInject !== false) {
    pi.on("before_agent_start", async (event, _ctx) => {
      const domain = detectDomainFromContext(projectName + " " + process.cwd(), config.memoryDomains);
      const contextKeywords = extractKeywordsFromContext(projectName, process.cwd());

      const memoryBlock = await store.formatForSystemPrompt(domain, contextKeywords);
      const skillIndex = await skillStore.formatIndexForSystemPrompt();
      const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

      const parts: string[] = [];
      if (memoryBlock) parts.push(memoryBlock);
      if (projectBlock) parts.push(projectBlock);
      if (skillIndex) parts.push(skillIndex);

      if (parts.length > 0) {
        return {
          systemPrompt: event.systemPrompt + "\n\n" + parts.join("\n\n"),
        };
      }
    });
  }

  // ── 3. Register the memory tool (with project store + domain inference) ──
  registerMemoryTool(pi, store, projectStore, dbManager, projectName, config.memoryDomains ?? [], config.memoryDomainKeywords ?? {}, config);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Setup background learning loop (with tool-call-aware nudge) ──
  setupBackgroundReview(pi, store, projectStore, config);

  // ── 6. Setup session-end flush ──
  setupSessionFlush(pi, store, projectStore, config);

  // ── 7. Setup auto-consolidation (inject consolidator into stores) ──
  store.setConsolidator(async (target, signal) => {
    return triggerConsolidation(pi, store, target, signal, config.consolidationTimeoutMs);
  });
  if (projectStore) {
    projectStore.setConsolidator(async (target, signal) => {
      const toolTarget = target === "memory" ? "project" : target;
      return triggerConsolidation(pi, projectStore, target, signal, config.consolidationTimeoutMs, toolTarget);
    });
  }
  registerConsolidateCommand(pi, store, config.consolidationTimeoutMs, projectStore, projectName);

  // ── 8. Setup correction detection ──
  setupCorrectionDetector(pi, store, projectStore, dbManager, config);

  // ── 9. Setup skill auto-trigger ──
  setupSkillAutoTrigger(pi, store, skillStore, config);

  // ── 10. Register commands ──
  registerInsightsCommand(pi, store, projectStore, projectName);
  registerSkillsCommand(pi, skillStore);
  registerInterviewCommand(pi, store);
  registerSwitchProjectCommand(pi);
  registerLearnMemoryCommand(pi);

  // ── 11. SQLite session search + extended memory ──
  registerSessionSearchTool(pi, dbManager);
  registerMemorySearchTool(pi, dbManager);
  registerIndexSessionsCommand(pi);

  // ── 12. Auto-index session on shutdown, then close the DB ──
  // Registered last so this runs after the session-flush shutdown handler and
  // is the final DB activity. Closing here truncates the WAL via
  // PRAGMA wal_checkpoint(TRUNCATE); without it the WAL only grows to its
  // high-water mark and is never reclaimed across sessions.
  //
  // Ordering is safe: Pi's ExtensionRunner.emit() runs same-extension handlers
  // sequentially in registration order and awaits each one, so the flush above
  // fully completes before close() runs. WARNING: do not register another
  // DB-writing session_shutdown handler after this block — it would run after
  // close() and silently no-op.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile && require("node:fs").existsSync(sessionFile)) {
        const sessionData = parseSessionFile(sessionFile);
        if (sessionData) {
          indexSession(dbManager, sessionData);
        }
      }
    } catch {
      // Silent fail — don't block shutdown
    } finally {
      try { dbManager.close(); } catch { /* best effort — never block shutdown */ }
    }
  });
}
