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
6. **Persist** — each document is also saved to `handoff-<timestamp>.md` next to the session file (disable with `AUTO_HANDOFF_SAVE=0`).

Manual commands:

- `/handoff [focus]` — write a handoff document and compact in place now.
- `/compact` — unchanged: Pi's default summary (the hook only intercepts the automatic passes and `/handoff`).

## Install

The extension imports only Pi's own packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`), which Pi's loader (jiti) resolves from its own install — no runtime dependencies.

**Option A — user extension (recommended):**

```sh
# with this repo checked out at ~/src/pi-auto-handoff (or wherever you keep sources)
mkdir -p ~/.pi/agent/extensions
ln -s ~/src/pi-auto-handoff/src/auto-handoff.ts ~/.pi/agent/extensions/auto-handoff.ts
```

**Option B — load directly:**

```sh
pi --extension ~/src/pi-auto-handoff/src/auto-handoff.ts
```

**Option C — project extension:** copy/symlink into `<project>/.pi/extensions/`.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `AUTO_HANDOFF_PERCENT` | `80` | Context percentage that triggers an automatic handoff |
| `AUTO_HANDOFF_ENABLED` | `1` | `0`/`false` disables the automatic trigger (`/handoff` keeps working) |
| `AUTO_HANDOFF_SAVE` | `1` | `0`/`false` disables saving documents to disk |

Example — hand off at 60% of the window, don't save files:

```sh
AUTO_HANDOFF_PERCENT=60 AUTO_HANDOFF_SAVE=0 pi
```

## How this maps to omp

| omp (built-in) | pi-auto-handoff (extension) |
| --- | --- |
| `compaction.thresholdPercent` | `AUTO_HANDOFF_PERCENT`, checked via `ctx.getContextUsage()` on `turn_end` |
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