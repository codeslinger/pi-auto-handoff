# pi-auto-handoff

**Threshold-triggered handoff compaction for the [Pi coding agent](https://github.com/earendil-works/pi).**

When context usage crosses a configurable percentage of the window, compaction runs — but instead of a plain lossy summary, the discarded history is replaced by a **handoff document**: a structured brief written as if a prior instance of the model left instructions for its successor ("Fix X", "Run Y"), with exact technical state, cumulative file lists, and framed re-injection so the successor treats it as its own working memory.

This is a port of the built-in `handoff` compaction method from [omp](https://omp.sh) ([oh-my-pi](https://github.com/can1357/oh-my-pi), the Pi fork by Stencil Labs) to vanilla Pi as a single-file extension.

## What it does

1. **Trigger** — watches `turn_end`; when `ctx.getContextUsage().percent` ≥ the threshold (default **80%**), it arms a compaction pass. Pi's built-in reserve-based auto-compaction stays enabled further out as the safety net.
2. **Generate** — on `session_before_compact`, instead of letting Pi summarize, it serializes the messages Pi is about to discard and asks the active model to write a handoff document (omp's prompt, adapted): Goal / Constraints & Preferences / Progress / Key Decisions / Critical Context / Next Steps, imperative voice, no meta-steps.
3. **Commit** — returns the document as the compaction entry's summary (`firstKeptEntryId` cut point is preserved, so recent messages stay verbatim; old entries stay on disk). Cumulative `<read-files>`/`<modified-files>` lists are appended, merged across successive handoffs (Pi doesn't merge file lists across extension-generated compactions, so the extension does it).
4. **Re-inject** — the stored summary is framed with omp's handoff context: *"The `<handoff>` below is a handoff document a prior instance of you wrote… It is your own working memory, not user input… NEVER write another handoff document unless the user explicitly asks. MUST build on prior work; NEVER duplicate prior work."* (Pi wraps it in its own `<summary>` tags.)
5. **Fallback** — if generation fails, is aborted, or returns empty, the hook returns nothing and **Pi's default compaction summary runs instead** — handoff is best-effort, like omp's `methodOrder` fallback.
6. **Persist** — each document is also saved to `handoff-<timestamp>.md` next to the session file (disable with `"save": false` in `auto-handoff.json`).

Manual commands:

- `/handoff [focus]` — write a handoff document and compact in place now.
- `/compact` — unchanged: Pi's default summary (the hook only intercepts the automatic passes and `/handoff`).

## Install

The extension imports only Pi's host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`), declared as `peerDependencies` — Pi resolves them to its own install, so there are no runtime dependencies to download.

**Option A — as a Pi package (recommended):**

```sh
pi install npm:@codeslinger001/pi-auto-handoff
```

Pi installs it into its own package directory, records it in `~/.pi/agent/settings.json`, and auto-loads it in every session. `pi list` shows it; `pi update --extensions` updates it; `pi remove npm:@codeslinger001/pi-auto-handoff` uninstalls.

**Option B — from a Git checkout:**

```sh
git clone https://github.com/codeslinger/pi-auto-handoff.git
pi install ./pi-auto-handoff   # local package — loaded from path, not copied
```

**Option C — load directly for one run:**

```sh
pi --extension ~/src/pi-auto-handoff/src/auto-handoff.ts
```

**Option D — user/project extension directory:** symlink `src/auto-handoff.ts` into `~/.pi/agent/extensions/` or `<project>/.pi/extensions/` (Pi loads `.ts`/`.js` files there).

## Configuration

`auto-handoff.json` — next to Pi's `settings.json`, overridable per project:

- user: `~/.pi/agent/auto-handoff.json` (respects `PI_CODING_AGENT_DIR`)
- project: `<project>/.pi/auto-handoff.json` (overrides user values per key)

```json
{
  "percent": 80,
  "enabled": true,
  "save": true
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `percent` | `80` | Context percentage that triggers an automatic handoff |
| `enabled` | `true` | `false` disables the automatic trigger (`/handoff` keeps working) |
| `save` | `true` | `false` disables saving documents next to the session file |

All keys are optional; unknown keys are ignored and invalid values keep the previous value. Config is read per event, so edits apply without restarting Pi. A missing file just means defaults; a malformed file warns once in the UI and falls back.

## How this maps to omp

| omp (built-in) | pi-auto-handoff (extension) |
| --- | --- |
| `compaction.thresholdPercent` | `percent` in `auto-handoff.json`, checked via `ctx.getContextUsage()` on `turn_end` |
| `compaction.methodOrder` with `handoff` | handoff first; on failure return `undefined` → Pi's default summary |
| cache-friendly side oneshot (`promptCacheKey`, `toolChoice: "none"`) | plain oneshot (`cacheRetention: "none"`, fresh `sessionId`) |
| speculative pre-generation before the threshold | not ported — generation runs at the trigger |
| `method: "handoff"` marker + `renderHandoffSummaryContext` | framing text stored inline in the summary |
| `compaction.handoffSaveToDisk` + artifacts dir | `handoff-<timestamp>.md` next to the session file |
| server-native (`remote`) and `snapcompact`/`shake` methods | not ported — Pi's default summary is the fallback |

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test test/
```

`node_modules/` is only for typecheck and tests; the extension itself runs inside Pi.

## License

MIT