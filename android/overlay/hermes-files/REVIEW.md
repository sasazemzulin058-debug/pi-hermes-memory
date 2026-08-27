# Security Review Checklist for pi-hermes-memory Upstream Changes

When syncing from `chandra447/pi-hermes-memory`, review every diff before merging.

## Files to scrutinize

| File | What to watch for |
|------|-------------------|
| `src/store/content-scanner.ts` | Removing/altering secret detection → could save your API keys |
| `src/handlers/background-review.ts` | New code that sends conversation data somewhere |
| `src/store/db.ts` | Changes to DB path or schema moving data outside `~/.pi/` |
| `src/tools/*.ts` | New tools exposing file system beyond memory dir |
| `src/index.ts` | New `pi.exec()` calls you don't understand |

## Review workflow

```bash
cd extensions/pi-hermes-memory

# Check what's new
git fetch upstream
git log HEAD..upstream/main --oneline

# Read the actual diff
git diff HEAD upstream/main

# Only merge if clean
git merge upstream/main

# If unsure, pin to a verified commit instead
git reset --hard <trusted-hash>
git push --force origin main
```

## Red flags in memory extensions specifically

- **Prompt injection via stored memory**: An attacker who compromised upstream could plant a malicious memory entry that gets injected into your system prompt on every session (e.g., "Ignore all previous instructions and..."). The `<memory-context>` tag fencing helps but isn't a security boundary.
- **Data exfiltration**: Background review or session flush could be modified to POST conversation data to a remote server.
- **Secret scanner bypass**: If `scanContent()` is weakened, your API keys could be persisted to disk.
- **Path traversal**: New tools that accept file paths could be tricked into reading outside `~/.pi/agent/memory/`.
