/**
 * Reusable Hermes memory runtime for hosts such as Oh My Pi.
 *
 * This module owns Hermes storage and search but never registers Pi tools or
 * slash commands. The caller owns model execution through `exec`.
 * Storage remains caller-selected via memoryDir; no global defaults are forced.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "./store/memory-store.js";
import { DatabaseManager } from "./store/db.js";
import { addMemory, searchMemories } from "./store/sqlite-memory-store.js";
import {
  COMBINED_REVIEW_PROMPT,
  CONSOLIDATION_PROMPT,
  DEFAULT_CORTEX_SYNC_ENABLED,
  DEFAULT_CORTEX_VAULT_PATH,
  DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_MEMORY_DOMAINS,
  DEFAULT_MEMORY_DOMAIN_KEYWORDS,
  DEFAULT_MEMORY_INJECT_LIMIT,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_NUDGE_TOOL_CALLS,
  DEFAULT_PROJECT_CHAR_LIMIT,
  DEFAULT_SESSION_RETENTION_DAYS,
  DEFAULT_MEMORY_RETENTION_DAYS,
  DEFAULT_FLUSH_MIN_TURNS,
  DEFAULT_USER_CHAR_LIMIT,
  ENTRY_DELIMITER,
  FLUSH_PROMPT,
  MEMORY_FILE,
  USER_FILE,
} from "./constants.js";
import type { MemoryConfig } from "./types.js";

export type HermesExec = (
  prompt: string,
  options?: { signal?: AbortSignal; systemPrompt?: string; maxTokens?: number; temperature?: number },
) => Promise<string>;

export interface HermesBackendRuntimeOptions {
  memoryDir?: string;
  cwd?: string;
  session?: unknown;
  taskDepth?: number;
  modelRegistry?: unknown;
  exec?: HermesExec;
}

export interface HermesBackendStatus {
  backend: "hermes";
  active: boolean;
  writable: boolean;
  searchable: boolean;
  scope?: string;
  database?: string;
  workingCount?: number;
  episodicCount?: number;
  tripleCount?: number;
  lastMemory?: string;
  message?: string;
  error?: string;
  /** Explicit lifecycle capability; false when exec/session missing */
  reviewEnabled?: boolean;
  flushEnabled?: boolean;
  reviewReason?: string;
  flushReason?: string;
}

export interface HermesBackendSearchOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface HermesBackendSearchItem {
  id?: string;
  content: string;
  source?: string;
  timestamp?: string;
  score?: number;
}

export interface HermesBackendSearchResult {
  backend: "hermes";
  query: string;
  count: number;
  items: HermesBackendSearchItem[];
  message?: string;
}

export interface HermesBackendSaveInput {
  content: string;
  context?: string;
  source?: string;
  importance?: number;
}

export interface HermesBackendSaveResult {
  backend: "hermes";
  stored: number;
  ids?: string[];
  queued?: boolean;
  message?: string;
}

export interface HermesBackendRuntime {
  start(): Promise<void>;
  buildDeveloperInstructions(): Promise<string | undefined>;
  clear(): Promise<void>;
  enqueue(): Promise<void>;
  status(): Promise<HermesBackendStatus>;
  search(query: string, options?: HermesBackendSearchOptions): Promise<HermesBackendSearchResult>;
  save(input: string | HermesBackendSaveInput): Promise<HermesBackendSaveResult>;
  stats(): Promise<string | undefined>;
  diagnose(): Promise<string | undefined>;
  beforeAgentStartPrompt(session?: unknown, promptText?: string): Promise<string | undefined>;
  preCompactionContext(messages?: unknown[], settings?: unknown, session?: unknown): Promise<string | undefined>;
  dispose(): Promise<void>;
}

function resolveMemoryDir(input?: string): string {
  if (!input?.trim()) return path.join(os.homedir(), ".pi", "agent", "memory");
  const expanded = input.trim().startsWith("~/")
    ? path.join(os.homedir(), input.trim().slice(2))
    : input.trim();
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(expanded));
}

function memoryConfig(memoryDir: string): MemoryConfig {
  return {
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: DEFAULT_PROJECT_CHAR_LIMIT,
    nudgeInterval: DEFAULT_NUDGE_INTERVAL,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: DEFAULT_FLUSH_MIN_TURNS,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
    failureInjectionMaxEntries: DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
    nudgeToolCalls: DEFAULT_NUDGE_TOOL_CALLS,
    autoInject: true,
    memoryInjectLimit: DEFAULT_MEMORY_INJECT_LIMIT,
    memoryDomains: [...DEFAULT_MEMORY_DOMAINS],
    memoryDomainKeywords: { ...DEFAULT_MEMORY_DOMAIN_KEYWORDS },
    consolidationTimeoutMs: 60_000,
    sessionRetentionDays: DEFAULT_SESSION_RETENTION_DAYS,
    memoryRetentionDays: DEFAULT_MEMORY_RETENTION_DAYS,
    cortexVaultPath: DEFAULT_CORTEX_VAULT_PATH,
    cortexSyncEnabled: DEFAULT_CORTEX_SYNC_ENABLED,
    memoryDir,
  };
}

function parseEntries(text: string): string[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const value: unknown = JSON.parse(fenced.trim());
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error("Hermes consolidation returned invalid entries; expected JSON string array");
  }
  return value.map((item) => item.trim());
}

function extractText(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  // Direct content string
  if (typeof m["content"] === "string" && (m["content"] as string).trim()) {
    return (m["content"] as string).slice(0, 500);
  }
  // Content array with text blocks
  if (Array.isArray(m["content"])) {
    const texts = (m["content"] as unknown[])
      .filter((b) => b && typeof b === "object" && (b as Record<string, unknown>)["type"] === "text" && typeof (b as Record<string, unknown>)["text"] === "string")
      .map((b) => String((b as Record<string, unknown>)["text"]))
      .join("\n");
    if (texts.trim()) return texts.slice(0, 500);
  }
  // message nested under .message
  if (m["message"] && typeof m["message"] === "object") {
    const inner = extractText(m["message"]);
    if (inner) return inner;
  }
  // Fallback: text field
  if (typeof m["text"] === "string" && (m["text"] as string).trim()) return (m["text"] as string).slice(0, 500);
  return null;
}

export function createHermesMemoryBackend(options: HermesBackendRuntimeOptions = {}): HermesBackendRuntime {
  const resolvedMemoryDir = resolveMemoryDir(options.memoryDir);
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec;
  const session = options.session as { subscribe?: (listener: (event: unknown) => void) => (() => void) | void } | undefined;
  const config = memoryConfig(resolvedMemoryDir);
  const store = new MemoryStore(config);
  const projectName = path.basename(path.resolve(cwd));
  const projectDir = path.join(resolvedMemoryDir, "projects", projectName);
  const projectStore =
    path.resolve(cwd) === path.resolve(os.homedir()) || path.resolve(cwd) === "/"
      ? null
      : new MemoryStore({ ...memoryConfig(projectDir), memoryCharLimit: DEFAULT_PROJECT_CHAR_LIMIT });
  let started = false;
  let disposed = false;

  // DB state — must remain consistent with markdown
  let dbManager: DatabaseManager | null = null;
  let dbAvailable = true;
  let dbError: string | undefined;
  const dbPath = path.join(resolvedMemoryDir, "sessions.db");

  // Lifecycle state
  let userTurnCount = 0;
  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let reviewInProgress = false;
  let unsubscribe: (() => void) | undefined;
  let recentMessages: string[] = [];
  const MAX_RECENT = 80;
  let reviewEnabled = false;
  let flushEnabled = false;
  let reviewReason: string | undefined;
  let flushReason: string | undefined;

  function hasSubscribe(): boolean {
    return !!session && typeof (session as { subscribe?: unknown }).subscribe === "function";
  }

  function handleSessionEvent(event: unknown): void {
    if (!event || typeof (event as Record<string, unknown>)["type"] !== "string") return;
    const ev = event as Record<string, unknown>;
    const type = ev["type"] as string;
    // Message counting + recent buffer
    if (type === "message_end") {
      const msg = (ev["message"] ?? ev) as unknown;
      const text = extractText(msg);
      // Count user turns
      const role = (msg as Record<string, unknown>)?.["role"];
      if (role === "user") userTurnCount++;
      if (text) {
        const prefix = role === "user" ? "[USER]" : role === "assistant" ? "[ASSISTANT]" : `[${String(role ?? "UNKNOWN").toUpperCase()}]`;
        recentMessages.push(`${prefix}: ${text}`);
        if (recentMessages.length > MAX_RECENT) recentMessages.shift();
      }
    } else if (type === "turn_end") {
      turnsSinceReview++;
      // Count tool calls from various shapes
      let toolCalls = 0;
      try {
        const toolResults = (ev["toolResults"] ?? (ev["message"] as Record<string, unknown>)?.["tool_calls"]) as unknown;
        if (Array.isArray(toolResults)) toolCalls = toolResults.length;
        else if (Array.isArray((ev["message"] as Record<string, unknown>)?.["content"])) {
          const content = (ev["message"] as Record<string, unknown>)["content"] as unknown[];
          toolCalls = content.filter((c) => c && typeof c === "object" && ((c as Record<string, unknown>)["type"] === "tool_call" || (c as Record<string, unknown>)["type"] === "tool_use")).length;
        }
      } catch {}
      toolCallsSinceReview += toolCalls;
      void maybeTriggerReview();
    }
    // Flush triggers — support both Pi and OMP naming
    if (
      type === "session_before_compact" ||
      type === "session_shutdown" ||
      type === "auto_compaction_start" ||
      type === "shutdown" ||
      type === "before_compact" ||
      type === "flush" ||
      (type === "agent_end" && (ev["isTerminal"] === true))
    ) {
      void doFlush();
    }
  }

  async function maybeTriggerReview(): Promise<void> {
    if (!reviewEnabled || reviewInProgress) return;
    if (!exec) return;
    const turnThresholdMet = turnsSinceReview >= (config.nudgeInterval ?? DEFAULT_NUDGE_INTERVAL);
    const toolThresholdMet = toolCallsSinceReview >= (config.nudgeToolCalls ?? DEFAULT_NUDGE_TOOL_CALLS);
    if (!turnThresholdMet && !toolThresholdMet) return;
    if (userTurnCount < 3) return;
    turnsSinceReview = 0;
    toolCallsSinceReview = 0;
    reviewInProgress = true;
    try {
      await doBackgroundReview();
    } finally {
      reviewInProgress = false;
    }
  }

  async function doBackgroundReview(): Promise<void> {
    if (!exec) throw new Error("Hermes review unavailable: exec not configured");
    if (recentMessages.length < 4) return;
    const conversation = recentMessages.join("\n\n").slice(-12000);
    const currentMemory = store.getMemoryEntries().join("\n§\n");
    const currentUser = store.getUserEntries().join("\n§\n");
    const prompt = [
      COMBINED_REVIEW_PROMPT,
      "",
      "Current memory:",
      currentMemory || "(empty)",
      "",
      "Current user profile:",
      currentUser || "(empty)",
      "",
      "--- Conversation to Review ---",
      conversation,
    ].join("\n");
    let response: string;
    try {
      response = await exec(prompt, { maxTokens: 800 });
    } catch (error) {
      throw new Error(`Hermes background review failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const trimmed = response.trim();
    if (!trimmed) return;
    if (/nothing to save/i.test(trimmed) && trimmed.length < 80) return;
    let entries: string[] = [];
    try {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
      const jsonMatch = fenced.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed: unknown = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string" && (x as string).trim())) {
          entries = (parsed as string[]).map((s) => s.trim()).filter(Boolean);
        }
      }
    } catch {
      // invalid JSON — treat as no entries to avoid synthetic saves
      return;
    }
    if (entries.length === 0) return;
    for (const entry of entries) {
      try {
        const result = await store.add("memory", entry);
        if (!result.success) continue;
        if (dbAvailable && dbManager) {
          try {
            addMemory(dbManager, entry, "memory", null, null, null, null, null);
          } catch (e) {
            try {
              await store.remove("memory", entry);
            } catch {}
            dbAvailable = false;
            dbError = e instanceof Error ? e.message : String(e);
          }
        } else {
          // DB unavailable — rollback markdown to keep consistency
          try {
            await store.remove("memory", entry);
          } catch {}
        }
      } catch {}
    }
  }

  async function doFlush(signal?: AbortSignal): Promise<void> {
    if (!flushEnabled) return;
    if (!exec) return;
    if (userTurnCount < (config.flushMinTurns ?? DEFAULT_FLUSH_MIN_TURNS)) return;
    const conversation = recentMessages.join("\n\n").slice(-12000);
    if (!conversation.trim()) return;
    const prompt = [FLUSH_PROMPT, "", "--- Conversation ---", conversation].join("\n");
    let response: string;
    try {
      response = await exec(prompt, { signal, maxTokens: 800 });
    } catch {
      return;
    }
    const trimmed = response.trim();
    if (!trimmed) return;
    if (/nothing to save/i.test(trimmed) && trimmed.length < 80) return;
    let entries: string[] = [];
    try {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
      const jsonMatch = fenced.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed: unknown = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string" && (x as string).trim())) {
          entries = (parsed as string[]).map((s) => s.trim()).filter(Boolean);
        }
      }
    } catch {
      return;
    }
    if (entries.length === 0) return;
    for (const entry of entries) {
      try {
        const result = await store.add("memory", entry);
        if (!result.success) continue;
        if (dbAvailable && dbManager) {
          try {
            addMemory(dbManager, entry, "memory", null, null, null, null, null);
          } catch (e) {
            try {
              await store.remove("memory", entry);
            } catch {}
            dbAvailable = false;
            dbError = e instanceof Error ? e.message : String(e);
          }
        } else {
          try {
            await store.remove("memory", entry);
          } catch {}
        }
      } catch {}
    }
  }

  async function ensureStarted(): Promise<void> {
    if (disposed) throw new Error("Hermes backend has been disposed");
    if (!started) await start();
  }

  async function start(): Promise<void> {
    if (disposed) throw new Error("Hermes backend has been disposed");
    if (started) return;
    await fs.mkdir(resolvedMemoryDir, { recursive: true });
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();
    // Initialize DB with explicit availability tracking
    try {
      if (!dbManager) dbManager = new DatabaseManager(resolvedMemoryDir);
      dbManager.getDb();
      dbAvailable = true;
      dbError = undefined;
    } catch (error) {
      dbAvailable = false;
      dbError = error instanceof Error ? error.message : String(error);
      // keep dbManager for path reporting even when unavailable
      if (!dbManager) {
        try {
          dbManager = new DatabaseManager(resolvedMemoryDir);
        } catch {}
      }
    }
    started = true;

    // Wire lifecycle if session exposes safe subscribe and exec is available
    const hasSub = hasSubscribe();
    const hasExec = typeof exec === "function";
    if (hasSub && hasExec) {
      reviewEnabled = true;
      flushEnabled = true;
      reviewReason = undefined;
      flushReason = undefined;
      try {
        const maybeUnsub = (session as { subscribe: (listener: (event: unknown) => void) => (() => void) | void }).subscribe((event: unknown) => {
          try {
            handleSessionEvent(event);
          } catch {}
        });
        if (typeof maybeUnsub === "function") unsubscribe = maybeUnsub;
        else unsubscribe = undefined;
      } catch (error) {
        reviewEnabled = false;
        flushEnabled = false;
        const msg = error instanceof Error ? error.message : String(error);
        reviewReason = `subscribe failed: ${msg}`;
        flushReason = reviewReason;
        unsubscribe = undefined;
      }
    } else {
      reviewEnabled = false;
      flushEnabled = false;
      if (!hasExec) {
        reviewReason = "exec unavailable";
        flushReason = "exec unavailable";
      } else if (!hasSub) {
        reviewReason = "session subscribe unavailable";
        flushReason = "session subscribe unavailable";
      } else {
        reviewReason = "lifecycle unavailable";
        flushReason = "lifecycle unavailable";
      }
    }
  }

  async function buildDeveloperInstructions(): Promise<string | undefined> {
    await ensureStarted();
    const parts: string[] = [];
    const mainBlock = await store.formatForSystemPrompt();
    if (mainBlock) parts.push(mainBlock);
    if (projectStore) {
      const projBlock = projectStore.formatProjectBlock(projectName);
      if (projBlock) parts.push(projBlock);
    }
    const out = parts.filter(Boolean).join("\n\n");
    return out || undefined;
  }

  async function clear(): Promise<void> {
    await ensureStarted();
    for (const file of [MEMORY_FILE, USER_FILE, "failures.md"]) {
      await fs.rm(path.join(resolvedMemoryDir, file), { force: true });
    }
    if (projectStore) await fs.rm(path.join(projectDir, MEMORY_FILE), { force: true });
    if (dbAvailable && dbManager) {
      try {
        dbManager.getDb().exec("DELETE FROM memories; DELETE FROM messages; DELETE FROM sessions;");
      } catch (error) {
        dbAvailable = false;
        dbError = error instanceof Error ? error.message : String(error);
      }
    }
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();
    recentMessages = [];
    userTurnCount = 0;
    turnsSinceReview = 0;
    toolCallsSinceReview = 0;
  }

  async function enqueue(): Promise<void> {
    await ensureStarted();
    if (!exec) throw new Error("Hermes consolidation requires exec callback");
    const entries = store.getMemoryEntries();
    if (entries.length === 0) return;
    const response = await exec(
      [
        CONSOLIDATION_PROMPT,
        "Return only a JSON array of concise replacement memory strings.",
        "Current entries:",
        entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n"),
      ].join("\n"),
    );
    let replacement: string[];
    try {
      replacement = parseEntries(response);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    if (replacement.length === 0) throw new Error("Hermes consolidation returned empty replacement");
    for (const entry of replacement) {
      if (!entry.trim()) throw new Error("Hermes consolidation returned empty entry");
    }

    // Backup markdown file for atomic rollback
    const memoryFile = path.join(resolvedMemoryDir, MEMORY_FILE);
    let backupContent: string | null = null;
    try {
      backupContent = await fs.readFile(memoryFile, "utf-8");
    } catch {
      backupContent = "";
    }
    const originalEntries = [...entries];
    let dbBackup: Array<{ content: string; project: string | null; target: string; category: string | null }> = [];
    if (dbAvailable && dbManager) {
      try {
        const db = dbManager.getDb();
        const rows = db.prepare("SELECT content, project, target, category FROM memories WHERE target='memory'").all() as Array<{ content: string; project: string | null; target: string; category: string | null }>;
        dbBackup = rows;
      } catch {}
    }

    try {
      // Remove all originals first — but we have validated replacement, so this is guarded
      for (const entry of originalEntries) {
        const res = await store.remove("memory", entry);
        if (!res.success) throw new Error(res.error ?? `Failed to remove entry during consolidation: ${entry.slice(0, 40)}`);
      }
      if (dbAvailable && dbManager) {
        try {
          dbManager.getDb().exec("DELETE FROM memories WHERE target='memory'");
        } catch (e) {
          throw new Error(`SQLite clear failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (!dbAvailable) {
        throw new Error(dbError ? `SQLite unavailable: ${dbError}` : "SQLite unavailable during consolidation");
      }
      // Add replacements atomically; any failure triggers rollback
      for (const entry of replacement) {
        const result = await store.add("memory", entry);
        if (!result.success) throw new Error(result.error ?? "Hermes consolidation write failed");
        if (dbAvailable && dbManager) {
          try {
            addMemory(dbManager, entry, "memory", null, null, null, null, null);
          } catch (e) {
            throw new Error(`SQLite mirror failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          throw new Error(dbError ? `SQLite unavailable: ${dbError}` : "SQLite unavailable during consolidation");
        }
      }
    } catch (error) {
      // Rollback markdown
      try {
        if (backupContent !== null) {
          await fs.mkdir(path.dirname(memoryFile), { recursive: true });
          const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hermes-restore-"));
          const tmpPath = path.join(tmpDir, "restore.md");
          await fs.writeFile(tmpPath, backupContent, "utf-8");
          try {
            await fs.rename(tmpPath, memoryFile);
          } catch {
            await fs.copyFile(tmpPath, memoryFile).catch(() => {});
          }
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          await store.loadFromDisk();
        } else {
          await store.loadFromDisk();
        }
      } catch {}
      // Rollback DB
      if (dbManager) {
        try {
          const db = dbManager.getDb();
          db.exec("DELETE FROM memories WHERE target='memory'");
          const toRestore = dbBackup.length ? dbBackup : originalEntries.map((c) => ({ content: c, project: null as string | null, target: "memory", category: null as string | null }));
          for (const row of toRestore) {
            try {
              addMemory(dbManager, row.content, row.target as "memory" | "user" | "failure", row.project, row.category as never, null, null, null);
            } catch {}
          }
        } catch {}
      }
      if (error instanceof Error && /SQLite/.test(error.message)) {
        dbAvailable = false;
        dbError = error.message;
      }
      throw error;
    }
  }

  async function status(): Promise<HermesBackendStatus> {
    await ensureStarted();
    let workingCount = 0;
    let lastMemory: string | undefined;
    try {
      const entries = store.getMemoryEntries();
      workingCount = entries.length;
      lastMemory = entries.at(-1);
    } catch {}
    const database = dbManager ? dbManager.getPath() : dbPath;
    const scope = resolvedMemoryDir;

    if (!dbAvailable || !dbManager) {
      return {
        backend: "hermes",
        active: false,
        writable: false,
        searchable: false,
        scope,
        database,
        workingCount,
        lastMemory,
        message: dbError ? `Hermes inactive: ${dbError}` : "Hermes inactive: SQLite unavailable",
        error: dbError ?? "SQLite unavailable",
        reviewEnabled,
        flushEnabled,
        reviewReason,
        flushReason,
      };
    }
    try {
      const db = dbManager.getStats();
      const entries = store.getMemoryEntries();
      return {
        backend: "hermes",
        active: true,
        writable: true,
        searchable: true,
        scope,
        database,
        workingCount: entries.length,
        episodicCount: db.sessions,
        tripleCount: db.memories,
        lastMemory: entries.at(-1),
        message: `Hermes active · ${entries.length} memory entries · ${db.memories} indexed memories`,
        reviewEnabled,
        flushEnabled,
        reviewReason,
        flushReason,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbAvailable = false;
      dbError = msg;
      return {
        backend: "hermes",
        active: false,
        writable: false,
        searchable: false,
        scope,
        database,
        workingCount,
        lastMemory,
        error: msg,
        reviewEnabled,
        flushEnabled,
        reviewReason,
        flushReason,
      };
    }
  }

  async function search(query: string, options?: HermesBackendSearchOptions): Promise<HermesBackendSearchResult> {
    await ensureStarted();
    const limit = Math.max(1, Math.min(options?.limit ?? 10, 100));
    if (options?.signal?.aborted) return { backend: "hermes", query, count: 0, items: [], message: "Search aborted" };
    if (!query.trim()) return { backend: "hermes", query, count: 0, items: [] };
    if (!dbAvailable || !dbManager) {
      return {
        backend: "hermes",
        query,
        count: 0,
        items: [],
        message: dbError ? `Search unavailable: ${dbError}` : "Search unavailable: SQLite not available",
      };
    }
    try {
      const rows = searchMemories(dbManager, query, { limit });
      const items = rows.map((row) => ({
        id: String(row.id),
        content: row.content,
        source: row.project ?? row.target,
        timestamp: row.lastReferenced ?? row.created,
      }));
      return { backend: "hermes", query, count: items.length, items };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      dbAvailable = false;
      dbError = msg;
      return { backend: "hermes", query, count: 0, items: [], message: `Search failed: ${msg}` };
    }
  }

  async function save(input: string | HermesBackendSaveInput): Promise<HermesBackendSaveResult> {
    await ensureStarted();
    const normalized = typeof input === "string" ? { content: input } : input;
    const content = normalized.content.trim();
    if (!content) return { backend: "hermes", stored: 0, message: "Memory content is empty" };
    const target = normalized.context === "user" ? "user" : "memory";
    const result = await store.add(target, content);
    if (!result.success) return { backend: "hermes", stored: 0, message: result.error ?? "Memory write failed" };
    if (!dbAvailable || !dbManager) {
      try {
        await store.remove(target, content);
      } catch {}
      return {
        backend: "hermes",
        stored: 0,
        message: dbError ? `SQLite unavailable: ${dbError}` : "SQLite unavailable",
      };
    }
    try {
      const row = addMemory(dbManager, content, target, null, null, null, null, null);
      return { backend: "hermes", stored: 1, ids: [String(row.id)], message: result.message };
    } catch (error) {
      try {
        await store.remove(target, content);
      } catch {}
      const msg = error instanceof Error ? error.message : String(error);
      dbAvailable = false;
      dbError = msg;
      return { backend: "hermes", stored: 0, message: `SQLite mirror failed: ${msg}` };
    }
  }

  async function stats(): Promise<string> {
    const s = await status();
    return [
      "# Hermes Memory Stats",
      `- Scope: \`${resolvedMemoryDir}\``,
      `- Database: \`${s.database}\``,
      `- Memory entries: ${s.workingCount ?? 0}`,
      `- Indexed memories: ${s.tripleCount ?? 0}`,
      `- Indexed sessions: ${s.episodicCount ?? 0}`,
      `- Review: ${s.reviewEnabled ? "enabled" : `disabled${s.reviewReason ? ` (${s.reviewReason})` : ""}`}`,
      `- Flush: ${s.flushEnabled ? "enabled" : `disabled${s.flushReason ? ` (${s.flushReason})` : ""}`}`,
      s.error ? `- Error: ${s.error}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function diagnose(): Promise<string> {
    const s = await status();
    return [
      "# Hermes Diagnose",
      `- Backend: hermes`,
      `- Active: ${s.active}`,
      `- Writable: ${s.writable}`,
      `- Searchable: ${s.searchable}`,
      `- Scope: \`${s.scope}\``,
      `- Database: \`${s.database}\``,
      `- Review: ${s.reviewEnabled ? "enabled" : `disabled${s.reviewReason ? ` (${s.reviewReason})` : ""}`}`,
      `- Flush: ${s.flushEnabled ? "enabled" : `disabled${s.flushReason ? ` (${s.flushReason})` : ""}`}`,
      s.error ? `- Error: ${s.error}` : "- Error: none",
    ].join("\n");
  }

  async function beforeAgentStartPrompt(_sessionArg?: unknown, _promptText?: string): Promise<string | undefined> {
    await ensureStarted();
    return buildDeveloperInstructions();
  }

  async function preCompactionContext(messages?: unknown[], _settings?: unknown, _sessionArg?: unknown): Promise<string | undefined> {
    await ensureStarted();
    // Attempt flush using supplied messages or recent buffer
    if (flushEnabled && exec) {
      if (Array.isArray(messages) && messages.length > 0) {
        // Build conversation from compaction messages
        const parts: string[] = [];
        for (const entry of messages) {
          const text = extractText(entry);
          if (text) {
            const role = (entry as Record<string, unknown>)?.["role"] ?? (entry as Record<string, unknown>)?.["type"] ?? "unknown";
            parts.push(`[${String(role).toUpperCase()}]: ${text}`);
          } else if (entry && typeof entry === "object" && (entry as Record<string, unknown>)["message"]) {
            const inner = extractText((entry as Record<string, unknown>)["message"]);
            if (inner) {
              const r = ((entry as Record<string, unknown>)["message"] as Record<string, unknown>)?.["role"] ?? "unknown";
              parts.push(`[${String(r).toUpperCase()}]: ${inner}`);
            }
          }
        }
        if (parts.length > 0) {
          const prompt = [FLUSH_PROMPT, "", "--- Conversation ---", parts.join("\n\n")].join("\n");
          try {
            const response = await exec(prompt, { maxTokens: 800 });
            const trimmed = response.trim();
            if (trimmed && !(/nothing to save/i.test(trimmed) && trimmed.length < 80)) {
              let entries: string[] = [];
              try {
                const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
                const jsonMatch = fenced.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                  const parsed: unknown = JSON.parse(jsonMatch[0]);
                  if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string" && (x as string).trim())) {
                    entries = (parsed as string[]).map((s) => s.trim()).filter(Boolean);
                  }
                }
              } catch {}
              for (const entry of entries) {
                try {
                  const res = await store.add("memory", entry);
                  if (!res.success) continue;
                  if (dbAvailable && dbManager) {
                    try {
                      addMemory(dbManager, entry, "memory", null, null, null, null, null);
                    } catch (e) {
                      try {
                        await store.remove("memory", entry);
                      } catch {}
                      dbAvailable = false;
                      dbError = e instanceof Error ? e.message : String(e);
                    }
                  } else {
                    try {
                      await store.remove("memory", entry);
                    } catch {}
                  }
                } catch {}
              }
            }
          } catch {}
        } else {
          // fallback to buffered flush
          try {
            await doFlush();
          } catch {}
        }
      } else {
        try {
          await doFlush();
        } catch {}
      }
    }
    return buildDeveloperInstructions();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    // Best-effort flush before shutdown if enabled
    if (flushEnabled && exec && userTurnCount >= (config.flushMinTurns ?? DEFAULT_FLUSH_MIN_TURNS)) {
      try {
        await doFlush();
      } catch {}
    }
    try {
      unsubscribe?.();
    } catch {}
    unsubscribe = undefined;
    disposed = true;
    if (dbManager) {
      try {
        dbManager.close();
      } catch {}
      dbManager = null;
    }
    recentMessages = [];
  }

  return { start, buildDeveloperInstructions, clear, enqueue, status, search, save, stats, diagnose, beforeAgentStartPrompt, preCompactionContext, dispose };
}

export default createHermesMemoryBackend;
