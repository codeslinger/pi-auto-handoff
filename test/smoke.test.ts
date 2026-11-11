/**
 * Smoke tests for the auto-handoff extension.
 *
 * Runs the real extension factory against a fake `pi`/`ExtensionContext` and
 * drives the registered handlers directly. Uses the real `convertToLlm` /
 * `serializeConversation` from Pi, so the prompt construction is exercised
 * end-to-end; only the LLM call is faked.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import autoHandoff from "../src/auto-handoff.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface FakeExtension {
  handlers: Map<string, (event: Any, ctx: Any) => unknown>;
  commands: Map<
    string,
    { description?: string; handler: (args: string, ctx: Any) => Promise<void> }
  >;
}

/**
 * Load the extension with `PI_CODING_AGENT_DIR` pointed at a fresh empty
 * directory, so config-file reads never see the real user configuration.
 * Tests that exercise configuration write into the returned directory.
 */
async function loadExtension(): Promise<FakeExtension & { agentDir: string }> {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-auto-handoff-agent-"),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, (event: Any, ctx: Any) => unknown>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: Any) => Promise<void> }
  >();
  const pi: Any = {
    on: (event: string, handler: (event: Any, ctx: Any) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand: (name: string, options: Any) => {
      commands.set(name, options);
    },
  };
  autoHandoff(pi);
  return { handlers, commands, agentDir };
}

function fakeContext(overrides: Partial<Any> = {}): Any {
  const notifications: string[] = [];
  return {
    notifications,
    hasUI: true,
    // No .pi/auto-handoff.json here; config tests override with a real
    // temporary project directory.
    cwd: path.join(os.tmpdir(), "pi-auto-handoff-no-project"),
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
    getContextUsage: () => ({
      tokens: 85_000,
      contextWindow: 100_000,
      percent: 85,
    }),
    getSystemPrompt: () => "You are a coding agent.",
    sessionManager: {
      getSessionFile: () => "/tmp/fake-sessions/session.jsonl",
    },
    ...overrides,
  };
}

function fakePreparation(overrides: Partial<Any> = {}): Any {
  return {
    firstKeptEntryId: "entry-9",
    messagesToSummarize: [
      {
        role: "user",
        content: [
          { type: "text", text: "please fix the parser bug in src/parser.ts" },
        ],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I read src/parser.ts and found an off-by-one.",
          },
        ],
        timestamp: Date.now(),
      },
    ],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 123_456,
    previousSummary: undefined,
    fileOps: {
      read: new Set(["src/parser.ts", "src/other.ts"]),
      written: new Set<string>(),
      edited: new Set(["src/parser.ts"]),
    },
    settings: {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    },
    ...overrides,
  };
}

function fakeBeforeCompactEvent(
  preparation: Any,
  reason: string,
  armedSignal?: AbortSignal,
): Any {
  return {
    type: "session_before_compact",
    preparation,
    branchEntries: [],
    customInstructions: "focus instructions",
    reason,
    willRetry: false,
    signal: armedSignal ?? new AbortController().signal,
  };
}

function fakeModelRegistry(documentText: string): Any {
  const calls: Any[] = [];
  return {
    calls,
    complete: async (model: Any, context: Any, options: Any) => {
      calls.push({ model, context, options });
      return {
        role: "assistant",
        content: [{ type: "text", text: documentText }],
        usage: { inputTokens: 1_000, outputTokens: 500 },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  };
}

const settledEvent: Any = {
  type: "agent_settled",
  aborted: false,
};

test("agent_settled triggers compaction at or above the threshold and re-arms after completion", async () => {
  const { handlers } = await loadExtension();
  const compactCalls: Any[] = [];
  const ctx = fakeContext({
    compact: (options: Any) => compactCalls.push(options),
  });

  const settled = handlers.get("agent_settled") as Any;

  // Below threshold: no compaction.
  await settled(
    settledEvent,
    {
      ...ctx,
      getContextUsage: () => ({
        tokens: 50_000,
        contextWindow: 100_000,
        percent: 50,
      }),
    },
  );
  assert.equal(compactCalls.length, 0);

  // At/above threshold: compaction armed once with the threshold focus.
  await settled(settledEvent, ctx);
  assert.equal(compactCalls.length, 1);
  assert.match(
    String(compactCalls[0]?.customInstructions),
    /Threshold-triggered maintenance/,
  );

  // While armed, no second trigger.
  await settled(settledEvent, ctx);
  assert.equal(compactCalls.length, 1);

  // onComplete disarms; a later high-usage run triggers again.
  compactCalls[0]?.onComplete?.();
  await settled(settledEvent, ctx);
  assert.equal(compactCalls.length, 2);
});

test("config is read from auto-handoff.json; project overrides the agent dir", async () => {
  const { handlers, agentDir } = await loadExtension();
  await fs.writeFile(
    path.join(agentDir, "auto-handoff.json"),
    JSON.stringify({ percent: 60 }),
  );

  const compactCalls: Any[] = [];
  const settled = handlers.get("agent_settled") as Any;

  // 65% ≥ the configured 60% (the default would be 80%) → triggers.
  await settled(
    settledEvent,
    fakeContext({
      compact: (options: Any) => compactCalls.push(options),
      getContextUsage: () => ({
        tokens: 65_000,
        contextWindow: 100_000,
        percent: 65,
      }),
    }),
  );
  assert.equal(compactCalls.length, 1);
  compactCalls[0]?.onComplete?.();

  // <cwd>/.pi/auto-handoff.json overrides the agent dir per key.
  const projectDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-auto-handoff-project-"),
  );
  await fs.mkdir(path.join(projectDir, ".pi"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".pi", "auto-handoff.json"),
    JSON.stringify({ percent: 95 }),
  );

  // 85% < the overridden 95% → no trigger.
  await settled(
    settledEvent,
    fakeContext({
      cwd: projectDir,
      compact: (options: Any) => compactCalls.push(options),
    }),
  );
  assert.equal(compactCalls.length, 1);

  // enabled: false disables the automatic trigger entirely.
  await fs.writeFile(
    path.join(projectDir, ".pi", "auto-handoff.json"),
    JSON.stringify({ enabled: false }),
  );
  await settled(
    settledEvent,
    fakeContext({
      cwd: projectDir,
      compact: (options: Any) => compactCalls.push(options),
    }),
  );
  assert.equal(compactCalls.length, 1);
});

test("a malformed config file warns once and falls back to defaults", async () => {
  const { handlers, agentDir } = await loadExtension();
  await fs.writeFile(path.join(agentDir, "auto-handoff.json"), "{ not json");

  const compactCalls: Any[] = [];
  const ctx = fakeContext({
    compact: (options: Any) => compactCalls.push(options),
  });
  const settled = handlers.get("agent_settled") as Any;
  const warnings = () =>
    ctx.notifications.filter((n: string) => /auto-handoff\.json/.test(n));

  // Defaults apply (85% ≥ default 80%) → triggers.
  await settled(settledEvent, ctx);
  assert.equal(compactCalls.length, 1);
  assert.equal(warnings().length, 1);

  // The warning fires once per file, not once per event.
  compactCalls[0]?.onComplete?.();
  await settled(settledEvent, ctx);
  assert.equal(compactCalls.length, 2);
  assert.equal(warnings().length, 1);
});

test("save: false disables saving the document to disk", async () => {
  const { handlers, agentDir } = await loadExtension();
  await fs.writeFile(
    path.join(agentDir, "auto-handoff.json"),
    JSON.stringify({ save: false }),
  );

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-auto-handoff-"));
  const ctx = fakeContext({
    model: { provider: "test", id: "test-model", contextWindow: 100_000 },
    modelRegistry: fakeModelRegistry("## Goal\nsave-disabled doc"),
    sessionManager: {
      getSessionFile: () => path.join(tmpDir, "session.jsonl"),
    },
  });

  const result = (await (handlers.get("session_before_compact") as Any)(
    fakeBeforeCompactEvent(fakePreparation(), "threshold"),
    ctx,
  )) as Any;

  assert.equal(result.compaction.details.savedPath, undefined);
  assert.deepEqual(await fs.readdir(tmpDir), []);
});

test("session_before_compact produces a framed handoff summary with file lists", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-auto-handoff-"));
  const { handlers } = await loadExtension();
  const registry = fakeModelRegistry(
    "## Goal\nFix the parser bug\n\n## Next Steps\n1. Run the tests",
  );
  const ctx = fakeContext({
    model: { provider: "test", id: "test-model", contextWindow: 100_000 },
    modelRegistry: registry,
    sessionManager: {
      getSessionFile: () => path.join(tmpDir, "session.jsonl"),
    },
  });

  // Arm via agent_settled so the pass counts as ours.
  const compactCalls: Any[] = [];
  const compactCtx = {
    ...ctx,
    compact: (options: Any) => compactCalls.push(options),
  };
  await (handlers.get("agent_settled") as Any)(settledEvent, compactCtx);
  assert.equal(compactCalls.length, 1);

  const result = (await (handlers.get("session_before_compact") as Any)(
    fakeBeforeCompactEvent(fakePreparation(), "manual"),
    ctx,
  )) as Any;

  assert.ok(result?.compaction, "expected a compaction result");
  const { summary, firstKeptEntryId, tokensBefore, usage, details } =
    result.compaction;
  assert.equal(firstKeptEntryId, "entry-9");
  assert.equal(tokensBefore, 123_456);
  assert.equal(usage.inputTokens, 1_000);
  assert.equal(details.method, "handoff");

  // Framing + document + cumulative file tags.
  assert.match(summary, /<handoff>/);
  assert.match(summary, /prior instance of you/);
  assert.match(summary, /## Goal/);
  assert.match(summary, /<read-files>/);
  assert.match(summary, /<modified-files>/);
  assert.match(summary, /src\/parser\.ts/);

  // File ops: edited beats read; read-only files stay under <read-files>.
  assert.deepEqual(details.modifiedFiles, ["src/parser.ts"]);
  assert.deepEqual(details.readFiles, ["src/other.ts"]);

  // Saved to disk next to the session file.
  assert.ok(details.savedPath?.startsWith(tmpDir));
  const saved = await fs.readFile(details.savedPath, "utf8");
  assert.match(saved, /## Goal/);

  // The oneshot request used the real serializer and compaction options.
  assert.equal(registry.calls.length, 1);
  assert.match(String(registry.calls[0]?.options?.cacheRetention), /none/);
  assert.ok(registry.calls[0]?.options?.sessionId);
  assert.match(
    String(registry.calls[0]?.context?.systemPrompt),
    /coding agent/,
  );
  const prompt = JSON.stringify(registry.calls[0]?.context?.messages);
  assert.match(prompt, /please fix the parser bug/);
  assert.match(prompt, /handoff document for another instance/);
});

test("unarmed manual /compact falls back to Pi's default summary", async () => {
  const { handlers } = await loadExtension();
  const ctx = fakeContext({
    model: { provider: "test", id: "test-model", contextWindow: 100_000 },
    modelRegistry: fakeModelRegistry("## Goal\nshould not be used"),
  });

  const result = await (handlers.get("session_before_compact") as Any)(
    fakeBeforeCompactEvent(fakePreparation(), "manual"),
    ctx,
  );
  assert.equal(result, undefined);
});

test("threshold and overflow passes get handoff documents even when unarmed", async () => {
  const { handlers } = await loadExtension();
  for (const reason of ["threshold", "overflow"]) {
    const ctx = fakeContext({
      model: { provider: "test", id: "test-model", contextWindow: 100_000 },
      modelRegistry: fakeModelRegistry("## Goal\ndoc"),
    });
    const result = (await (handlers.get("session_before_compact") as Any)(
      fakeBeforeCompactEvent(fakePreparation(), reason),
      ctx,
    )) as Any;
    assert.ok(
      result?.compaction,
      `${reason} should produce a handoff compaction`,
    );
  }
});

test("previous summary file lists are merged cumulatively", async () => {
  const { handlers } = await loadExtension();
  const ctx = fakeContext({
    model: { provider: "test", id: "test-model", contextWindow: 100_000 },
    modelRegistry: fakeModelRegistry("## Goal\ndoc"),
  });
  const previousSummary = `Context replaced.\n<handoff>old doc</handoff>\n\n<read-files>\nold/one.ts\n</read-files>\n<modified-files>\nold/two.ts\n</modified-files>`;

  const result = (await (handlers.get("session_before_compact") as Any)(
    fakeBeforeCompactEvent(fakePreparation({ previousSummary }), "threshold"),
    ctx,
  )) as Any;
  const details = result.compaction.details;
  assert.ok(details.readFiles.includes("old/one.ts"));
  assert.ok(details.modifiedFiles.includes("old/two.ts"));
  assert.ok(details.modifiedFiles.includes("src/parser.ts"));
});

test("generation failure falls back to default compaction", async () => {
  const { handlers } = await loadExtension();
  const ctx = fakeContext({
    model: { provider: "test", id: "test-model", contextWindow: 100_000 },
    modelRegistry: {
      complete: async () => {
        throw new Error("provider exploded");
      },
    },
  });

  const result = await (handlers.get("session_before_compact") as Any)(
    fakeBeforeCompactEvent(fakePreparation(), "threshold"),
    ctx,
  );
  assert.equal(result, undefined);
});

test("empty or aborted generation falls back to default compaction", async () => {
  const { handlers } = await loadExtension();

  // Empty document.
  const emptyCtx = fakeContext({
    model: { provider: "test", id: "test-model", contextWindow: 100_000 },
    modelRegistry: fakeModelRegistry("   "),
  });
  assert.equal(
    await (handlers.get("session_before_compact") as Any)(
      fakeBeforeCompactEvent(fakePreparation(), "threshold"),
      emptyCtx,
    ),
    undefined,
  );

  // Aborted signal.
  const controller = new AbortController();
  controller.abort();
  const abortedCtx = fakeContext({
    model: { provider: "test", id: "test-model", contextWindow: 100_000 },
    modelRegistry: fakeModelRegistry("## Goal\ndoc"),
  });
  assert.equal(
    await (handlers.get("session_before_compact") as Any)(
      fakeBeforeCompactEvent(fakePreparation(), "threshold", controller.signal),
      abortedCtx,
    ),
    undefined,
  );
});

test("no model falls back to default compaction", async () => {
  const { handlers } = await loadExtension();
  const ctx = fakeContext({ model: undefined });
  const result = await (handlers.get("session_before_compact") as Any)(
    fakeBeforeCompactEvent(fakePreparation(), "threshold"),
    ctx,
  );
  assert.equal(result, undefined);
});

test("/handoff command arms a focused compaction and is idempotent while in flight", async () => {
  const { handlers, commands } = await loadExtension();
  const compactCalls: Any[] = [];
  const ctx = fakeContext({
    compact: (options: Any) => compactCalls.push(options),
  });

  const handoff = commands.get("handoff")!;
  assert.ok(handoff.description);

  await handoff.handler("do the thing", ctx);
  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0]?.customInstructions, "do the thing");

  // Armed by the first call: a second invocation is a no-op until it settles.
  await handoff.handler("again", ctx);
  assert.equal(compactCalls.length, 1);
  assert.match(String(ctx.notifications[0]), /Writing handoff document/);

  // Default focus when no args are given.
  compactCalls[0]?.onError?.();
  await handoff.handler("", ctx);
  assert.equal(compactCalls.length, 2);
  assert.match(
    String(compactCalls[1]?.customInstructions),
    /Threshold-triggered maintenance/,
  );
});
