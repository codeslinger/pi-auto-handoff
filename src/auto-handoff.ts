/**
 * pi-auto-handoff — threshold-triggered handoff compaction for the Pi coding agent.
 *
 * Ports the "auto-handoff" compaction method from omp (oh-my-pi, the Pi fork at
 * https://github.com/can1357/oh-my-pi) to vanilla Pi as an extension:
 *
 * - When context usage crosses a percentage threshold, compaction runs — but
 *   instead of a plain summary, the discarded history is replaced by a
 *   *handoff document*, written as if a prior instance of the model left
 *   instructions for its successor ("Fix X", "Run Y", never first person).
 * - The document is committed as a normal compaction entry: recent messages
 *   (keepRecentTokens) are kept verbatim, old entries stay on disk.
 * - The stored summary is framed on re-injection so the successor treats it
 *   as its own working memory, not user input, and never re-writes it.
 * - File lists (read/modified) are tracked cumulatively across handoffs and
 *   appended to the document, mirroring Pi's default compaction behavior.
 * - The document is optionally saved to `<session-dir>/handoff-<timestamp>.md`.
 * - If document generation fails, is aborted, or comes back empty, Pi's default
 *   compaction summary runs instead — handoff is best-effort, like omp's
 *   method-order fallback.
 *
 * Commands:
 *   /handoff [focus]  Write a handoff document and compact in place.
 *                     Manual `/compact` keeps Pi's default summary.
 *
 * Configuration (auto-handoff.json — next to Pi's settings.json in the
 * agent directory, overridable per project in <cwd>/.pi/auto-handoff.json):
 *   percent   Context percentage that triggers an automatic handoff
 *             (default 80).
 *   enabled   false disables the automatic trigger; `/handoff` keeps
 *             working (default true).
 *   save      false disables saving the document to disk next to the
 *             session file (default true).
 * Config is read per event, so edits apply without restarting Pi; a
 * missing or malformed file falls back to defaults (malformed warns once).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  FileOperations,
} from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  getAgentDir,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// Configuration
// ============================================================================

// Configuration lives in auto-handoff.json: <agent-dir>/auto-handoff.json
// (the same directory as Pi's settings.json) overridden per project by
// <cwd>/.pi/auto-handoff.json. Project values win per key.

const DEFAULT_THRESHOLD_PERCENT = 80;
const CONFIG_FILE_NAME = "auto-handoff.json";

/** Resolved configuration for one event. */
interface AutoHandoffConfig {
  /** Context percentage that triggers an automatic handoff. */
  percent: number;
  /** Whether the automatic threshold trigger is enabled. */
  enabled: boolean;
  /** Whether handoff documents are saved next to the session file. */
  save: boolean;
}

const DEFAULT_CONFIG: AutoHandoffConfig = {
  percent: DEFAULT_THRESHOLD_PERCENT,
  enabled: true,
  save: true,
};

/** Warn once per file per runtime — otherwise a malformed config file
 *  silently reverts every event to defaults, which is hard to debug. */
const warnedConfigFiles = new Set<string>();

function warnConfigFile(
  file: string,
  ctx: ExtensionContext,
  message: string,
): void {
  if (!ctx.hasUI || warnedConfigFiles.has(file)) return;
  warnedConfigFiles.add(file);
  ctx.ui.notify(`Auto-handoff: ignoring ${file} (${message})`, "warning");
}

/** Booleans, plus the legacy env-var spellings this file replaces. */
function flagValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    return raw === "" ? fallback : !["0", "false", "no", "off"].includes(raw);
  }
  return fallback;
}

function percentValue(value: unknown, fallback: number): number {
  const raw = typeof value === "string" ? Number(value.trim()) : value;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : fallback;
}

/** Validate one parsed file onto a base config; invalid keys keep the base. */
function applyConfigObject(
  base: AutoHandoffConfig,
  value: Record<string, unknown> | undefined,
): AutoHandoffConfig {
  if (!value) return base;
  return {
    percent: percentValue(value.percent, base.percent),
    enabled: flagValue(value.enabled, base.enabled),
    save: flagValue(value.save, base.save),
  };
}

/** Read and parse one config file. Missing files are silent (they just mean
 *  defaults or agent-dir values apply); unreadable or malformed files warn
 *  once and are ignored. */
async function readConfigObject(
  file: string,
  ctx: ExtensionContext,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnConfigFile(file, ctx, (error as Error).message);
    }
    return undefined;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM, like Pi
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnConfigFile(file, ctx, "expected a JSON object");
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    warnConfigFile(file, ctx, (error as Error).message);
    return undefined;
  }
}

/** Effective config for one event: agent-dir values overridden by project. */
async function loadConfig(ctx: ExtensionContext): Promise<AutoHandoffConfig> {
  const files = [
    path.join(getAgentDir(), CONFIG_FILE_NAME),
    path.resolve(ctx.cwd, ".pi", CONFIG_FILE_NAME),
  ];
  let config = DEFAULT_CONFIG;
  for (const file of files) {
    config = applyConfigObject(config, await readConfigObject(file, ctx));
  }
  return config;
}

// ============================================================================
// Prompts (adapted from omp's packages/agent/src/compaction/prompts/)
// ============================================================================

/** omp's handoff-document.md: a handoff written for a successor instance. */
const HANDOFF_DOCUMENT_PROMPT = `<critical>
Write a handoff document for another instance of yourself.
The handoff MUST be sufficient for seamless continuation without access to this conversation.
Output ONLY the handoff document. No preamble, no commentary, no wrapper text.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, commands run
- Test results, observed failures
- Decisions made
- Partial work affecting the next step
Address the successor directly in the imperative ("Fix X", "Run Y") — never first person ("I need to…", "my attempt…").
Never list writing, generating, or delivering a handoff/summary/context document as progress or a next step.
Progress and Next Steps cover the user's task only.
</instruction>

<output>
Use exactly this structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- Code snippets, file paths, function/type names, error messages, data essential to continue
- Repository state if relevant

## Next Steps
1. [What should happen next]
</output>`;

/** omp's auto-handoff-threshold-focus.md: focus for threshold-triggered passes. */
const AUTO_HANDOFF_THRESHOLD_FOCUS =
  "Threshold-triggered maintenance: preserve critical implementation state and immediate next actions.";

/**
 * omp's handoff-summary-context.md: framing around the stored summary so the
 * successor model treats the handoff as its own memory, not user input.
 * Pi wraps compaction summaries in its own <summary> tags; this framing sits
 * inside them.
 */
function frameHandoffSummary(summary: string): string {
  return `Context replaced. The <handoff> below is a handoff document a prior instance of you wrote from the full conversation. It is your own working memory, not user input.
- First person inside it refers to you (the prior instance).
- "Next Steps" is your own resumed plan; re-check it against the latest user message before acting.
- The handoff already exists and is complete: NEVER write another handoff document unless the user explicitly asks.
- MUST build on prior work; NEVER duplicate prior work.

<handoff>
${summary}
</handoff>`;
}

// ============================================================================
// File tracking (cumulative across handoffs, like Pi's default compaction)
// ============================================================================

interface HandoffFiles {
  readFiles: string[];
  modifiedFiles: string[];
}

/** Parse the file list tags out of a previous summary we generated. */
function parseFileTag(summary: string | undefined, tag: string): string[] {
  if (!summary) return [];
  const match = summary.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "m"));
  const body = match?.[1];
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Cumulative file lists from this compaction's tool operations, merged with
 * the lists carried by the previous summary (Pi does not merge file lists
 * across extension-generated compactions, so we do it ourselves).
 */
function handoffFiles(
  fileOps: FileOperations,
  previousSummary: string | undefined,
): HandoffFiles {
  const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
  for (const file of parseFileTag(previousSummary, "modified-files"))
    modified.add(file);
  const read = new Set<string>(
    [...fileOps.read].filter((file) => !modified.has(file)),
  );
  for (const file of parseFileTag(previousSummary, "read-files")) {
    if (!modified.has(file)) read.add(file);
  }
  return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

function formatFileTags(files: HandoffFiles): string {
  const sections: string[] = [];
  if (files.readFiles.length > 0) {
    sections.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
  }
  if (files.modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

// ============================================================================
// Handoff generation
// ============================================================================

interface HandoffDetails {
  method: "handoff";
  readFiles: string[];
  modifiedFiles: string[];
  savedPath?: string;
}

async function generateHandoffDocument(
  ctx: ExtensionContext,
  model: Model<any>,
  conversationText: string,
  customInstructions: string | undefined,
  previousSummary: string | undefined,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  const parts: string[] = [HANDOFF_DOCUMENT_PROMPT];
  if (previousSummary) {
    parts.push(
      `Earlier context was already summarized/handed off below. Build on it; never duplicate its work:\n\n${previousSummary}`,
    );
  }
  if (customInstructions) {
    parts.push(`Additional focus: ${customInstructions}`);
  }
  parts.push(`<conversation>\n${conversationText}\n</conversation>`);

  const message: Message = {
    role: "user",
    content: [{ type: "text", text: parts.join("\n\n") }],
    timestamp: Date.now(),
  };

  return ctx.modelRegistry.complete(
    model,
    // omp passes the live agent system prompt so the document inherits the
    // agent's conventions (and, in omp, reads the provider prompt cache).
    { systemPrompt: ctx.getSystemPrompt(), messages: [message] },
    // One-off request: no prompt-cache writes.
    { signal, cacheRetention: "none", sessionId: uuidv7() },
  );
}

function documentText(response: AssistantMessage): string {
  return response.content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function saveHandoffDocument(
  ctx: ExtensionContext,
  document: string,
): Promise<string | undefined> {
  try {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return undefined;
    const dir = path.dirname(sessionFile);
    await fs.mkdir(dir, { recursive: true });
    const file = `handoff-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    const target = path.join(dir, file);
    await fs.writeFile(target, `${document}\n`, "utf8");
    return target;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Extension
// ============================================================================

export default function autoHandoff(pi: ExtensionAPI): void {
  /**
   * Set when WE arm a compaction (the auto threshold or `/handoff`) so the
   * session_before_compact hook knows to produce a handoff document.
   * Unarmed manual `/compact` keeps Pi's default summary. Pi's own threshold
   * and overflow passes (reason "threshold"/"overflow") also get handoff
   * documents — they are the same automatic passes omp routes through its
   * method order.
   */
  let armed = false;
  const disarm = () => {
    armed = false;
  };

  const triggerHandoff = (
    ctx: ExtensionContext,
    focus: string | undefined,
  ): void => {
    armed = true;
    ctx.compact({
      customInstructions: focus,
      onComplete: disarm,
      onError: disarm,
    });
  };

  // Auto-trigger: omp's compaction.thresholdPercent. Fires our own
  // compaction pass; Pi's built-in reserve-based threshold stays enabled
  // further out as the safety net.
  pi.on("turn_end", async (_event, ctx) => {
    if (armed) return;
    const config = await loadConfig(ctx);
    if (!config.enabled) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || usage.percent < config.percent)
      return;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Auto-handoff: context at ${Math.round(usage.percent)}% (≥${config.percent}%) — writing handoff document`,
        "info",
      );
    }
    triggerHandoff(ctx, AUTO_HANDOFF_THRESHOLD_FOCUS);
  });

  // Belt-and-braces: never wedge `armed` if a compaction ends without
  // calling onComplete/onError.
  pi.on("session_compact", disarm);
  pi.on("session_compact_failed", disarm);

  // The compaction itself: replace Pi's default summary with a handoff
  // document. Returning undefined (no model, empty/aborted generation,
  // provider failure) falls back to Pi's default compaction.
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, reason, customInstructions, signal } = event;

    // Manual `/compact` without our marker keeps Pi's default summary.
    if (reason === "manual" && !armed) return;

    const model = ctx.model;
    if (!model) return;

    // Everything Pi is about to discard is the document's source material.
    const discarded = [
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ];
    const conversationText = serializeConversation(convertToLlm(discarded));
    if (!conversationText.trim() && !preparation.previousSummary) return;

    let document: string;
    try {
      const response = await generateHandoffDocument(
        ctx,
        model,
        conversationText,
        customInstructions,
        preparation.previousSummary,
        signal,
      );
      if (signal.aborted) return;
      document = documentText(response);
      if (!document) return;

      const files = handoffFiles(
        preparation.fileOps,
        preparation.previousSummary,
      );
      const { save } = await loadConfig(ctx);
      const savedPath = save
        ? await saveHandoffDocument(ctx, document)
        : undefined;
      const details: HandoffDetails = {
        method: "handoff",
        ...files,
        savedPath,
      };

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Handoff committed (${preparation.tokensBefore.toLocaleString()} tokens summarized${
            savedPath ? ` · saved to ${savedPath}` : ""
          })`,
          "info",
        );
      }

      return {
        compaction: {
          summary: frameHandoffSummary(document + formatFileTags(files)),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
          details,
        },
      };
    } catch (error) {
      if (!signal.aborted && ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `Auto-handoff: generation failed (${message}); using default compaction`,
          "warning",
        );
      }
      return;
    }
  });

  // Manual handoff, like omp's /handoff: compact in place with a document.
  pi.registerCommand("handoff", {
    description:
      "Summarize the session into a handoff document and compact in place [focus]",
    handler: async (args, ctx) => {
      if (armed) {
        if (ctx.hasUI) ctx.ui.notify("Handoff already in progress", "warning");
        return;
      }
      const focus = args.trim() || AUTO_HANDOFF_THRESHOLD_FOCUS;
      if (ctx.hasUI) ctx.ui.notify("Writing handoff document…", "info");
      triggerHandoff(ctx, focus);
    },
  });
}
