import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  filter,
  firstValueFrom,
  lastValueFrom,
  Observable,
  of,
  Subject,
  toArray,
} from "rxjs";
import { closeLocalRuntime, getLocalRuntime } from "../src/local-runtime";

const directories: string[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) closeLocalRuntime(path);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "free-bot-runtime-"));
  directories.push(directory);
  const path = join(directory, "conversations.sqlite");
  paths.push(path);
  return { path, ...getLocalRuntime(path) };
}

class AnswerAgent extends AbstractAgent {
  received: Message[] = [];
  constructor(private readonly tools = false) {
    super({ agentId: "assistant" });
  }
  run(input: RunAgentInput) {
    this.received = structuredClone(input.messages);
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `answer-${input.runId}`,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `answer-${input.runId}`,
        delta: "Local reply",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: `answer-${input.runId}` },
    ];
    if (this.tools)
      events.push(
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-1",
          toolCallName: "lookup",
          parentMessageId: `answer-${input.runId}`,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call-1",
          delta: '{"query":"local"}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tool-result",
          toolCallId: "call-1",
          content: "found",
          role: "tool",
        },
      );
    events.push({ type: EventType.STATE_SNAPSHOT, snapshot: { ready: true } });
    events.push({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: { type: "success" },
    });
    return of(...events);
  }
}

class WaitingAgent extends AbstractAgent {
  readonly started = Promise.withResolvers<void>();
  readonly stream = new Subject<BaseEvent>();
  constructor() {
    super({ agentId: "assistant" });
  }
  run(input: RunAgentInput) {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "partial",
        role: "assistant",
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "partial",
        delta: "Partial",
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "partial",
      });
      const subscription = this.stream.subscribe(subscriber);
      this.started.resolve();
      return subscription;
    });
  }
}

function input(threadId: string, runId: string): RunAgentInput {
  return {
    threadId,
    runId,
    messages: [{ id: `user-${runId}`, role: "user", content: "Hello" }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

test("stores native history, tool calls, state and replay across a restart without a project key", async () => {
  const { path, runner, client } = fixture();
  expect(getLocalRuntime(path).runner).toBe(runner);
  const events = await lastValueFrom(
    runner
      .run({
        threadId: "thread-1",
        agent: new AnswerAgent(true),
        input: input("thread-1", "run-1"),
      })
      .pipe(toArray()),
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(runner.getThreadState("thread-1")).toEqual({ ready: true });
  const native = runner.getThreadMessages("thread-1");
  const assistant = native.find((message) => message.role === "assistant");
  expect(
    assistant?.role === "assistant" && assistant.toolCalls?.[0]?.function.name,
  ).toBe("lookup");
  const wire = await client.getThreadMessages({
    threadId: "thread-1",
    userId: "dev-local-user",
  });
  expect(
    wire.messages.find((message) => message.role === "assistant")
      ?.toolCalls?.[0],
  ).toEqual({ id: "call-1", name: "lookup", args: '{"query":"local"}' });
  closeLocalRuntime(path);
  const restored = getLocalRuntime(path);
  expect(restored.runner.getThreadMessages("thread-1")).toEqual(native);
  const replay = await lastValueFrom(
    restored.runner
      .connect({ threadId: "thread-1", agentId: "assistant" })
      .pipe(toArray()),
  );
  expect(
    replay.some(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT &&
        event.delta === "Local reply",
    ),
  ).toBe(true);
  const second = new AnswerAgent();
  await lastValueFrom(
    restored.runner
      .run({
        threadId: "thread-1",
        agent: second,
        input: input("thread-1", "run-2"),
      })
      .pipe(toArray()),
  );
  expect(
    second.received.some(
      (message) => message.role === "tool" && message.toolCallId === "call-1",
    ),
  ).toBe(true);
  expect(
    restored.runner
      .getThreadMessages("thread-1")
      .filter((message) => message.id === "user-run-1"),
  ).toHaveLength(1);
  expect(restored.runner.listThreads()).toHaveLength(1);
});

test("browser and headless locks share contention and stale cleanup never releases a newer run", async () => {
  const { runner, client } = fixture();
  const lock = {
    threadId: "busy",
    runId: "headless",
    userId: "dev-local-user",
    agentId: "assistant",
  };
  await client.ɵacquireThreadLock(lock);
  expect(() =>
    runner.run({
      threadId: "busy",
      agent: new AnswerAgent(),
      input: input("busy", "browser"),
    }),
  ).toThrow("already running");
  await client.ɵcleanupThreadLock({ threadId: "busy", runId: "stale" });
  await expect(
    client.ɵacquireThreadLock({ ...lock, runId: "other" }),
  ).rejects.toMatchObject({ status: 409 });
  await lastValueFrom(
    runner
      .run({
        threadId: "busy",
        agent: new AnswerAgent(),
        input: input("busy", "headless"),
      })
      .pipe(toArray()),
  );
  await client.ɵacquireThreadLock({ ...lock, runId: "newer" });
  await client.ɵcleanupThreadLock({ threadId: "busy", runId: "headless" });
  await expect(
    client.ɵacquireThreadLock({ ...lock, runId: "other" }),
  ).rejects.toMatchObject({ status: 409 });
  await client.ɵcleanupThreadLock({ threadId: "busy", runId: "newer" });
});

test("exact-run stop keeps partial messages and concurrent runs use independent threads", async () => {
  const { path, runner } = fixture();
  const agent = new WaitingAgent();
  const running = lastValueFrom(
    runner
      .run({ threadId: "stopped", agent, input: input("stopped", "run-stop") })
      .pipe(toArray()),
  );
  await agent.started.promise;
  await firstValueFrom(
    runner
      .connect({ threadId: "stopped" })
      .pipe(filter((event) => event.type === EventType.TEXT_MESSAGE_END)),
  );
  await lastValueFrom(
    runner
      .run({
        threadId: "other",
        agent: new AnswerAgent(),
        input: input("other", "run-other"),
      })
      .pipe(toArray()),
  );
  expect(await runner.stop({ threadId: "stopped", runId: "older" })).toBe(
    false,
  );
  expect(await runner.isRunning({ threadId: "stopped" })).toBe(true);
  expect(await runner.stop({ threadId: "stopped", runId: "run-stop" })).toBe(
    true,
  );
  const events = await running;
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(
    runner
      .getThreadMessages("stopped")
      .some((message) => message.content === "Partial"),
  ).toBe(true);
  closeLocalRuntime(path);
  expect(
    getLocalRuntime(path)
      .runner.getThreadMessages("stopped")
      .some((message) => message.content === "Partial"),
  ).toBe(true);
});

test("agent failure saves partial history and releases the conversation", async () => {
  const { runner } = fixture();
  const agent = new WaitingAgent();
  const running = lastValueFrom(
    runner
      .run({ threadId: "failed", agent, input: input("failed", "failure") })
      .pipe(toArray()),
  );
  await agent.started.promise;
  await firstValueFrom(
    runner
      .connect({ threadId: "failed" })
      .pipe(filter((event) => event.type === EventType.TEXT_MESSAGE_END)),
  );
  agent.stream.error(new Error("Synthetic failure"));
  const events = await running;
  expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(true);
  expect(
    runner
      .getThreadMessages("failed")
      .some((message) => message.content === "Partial"),
  ).toBe(true);
  expect(await runner.isRunning({ threadId: "failed" })).toBe(false);
  await lastValueFrom(
    runner
      .run({
        threadId: "failed",
        agent: new AnswerAgent(),
        input: input("failed", "retry"),
      })
      .pipe(toArray()),
  );
});

test("rejects another user or agent and prevents deletion during a run", async () => {
  const { runner, client } = fixture();
  await expect(
    client.createThread({
      threadId: "private",
      agentId: "assistant",
      userId: "someone-else",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await client.createThread({
    threadId: "private",
    agentId: "assistant",
    userId: "dev-local-user",
  });
  expect(() =>
    runner.connect({ threadId: "private", agentId: "wrong-agent" }),
  ).toThrow("another agent");
  const agent = new WaitingAgent();
  const running = lastValueFrom(
    runner
      .run({ threadId: "private", agent, input: input("private", "running") })
      .pipe(toArray()),
  );
  await agent.started.promise;
  await firstValueFrom(
    runner
      .connect({ threadId: "private" })
      .pipe(filter((event) => event.type === EventType.TEXT_MESSAGE_END)),
  );
  expect(() => runner.clearThreads()).toThrow("running conversations");
  await runner.stop({ threadId: "private" });
  await running;
  runner.clearThreads();
  expect(runner.listThreads()).toEqual([]);
});

test("headless persisted text takes precedence over model instructions with the same ID", async () => {
  const { path, runner } = fixture();
  const runInput = input("summary", "handoff");
  const shown: Message = {
    id: "handoff-message",
    role: "user",
    content: "Visible handoff summary",
  };
  runInput.messages = [{ ...shown, content: "MODEL ONLY INSTRUCTIONS" }];
  await lastValueFrom(
    runner
      .run({
        threadId: "summary",
        agent: new AnswerAgent(),
        input: runInput,
        persistedInputMessages: [shown],
      })
      .pipe(toArray()),
  );
  expect(runner.getThreadMessages("summary")[0]).toEqual(shown);
  expect(JSON.stringify(runner.getThreadEvents("summary"))).not.toContain(
    "MODEL ONLY INSTRUCTIONS",
  );
  closeLocalRuntime(path);
  expect(getLocalRuntime(path).runner.getThreadMessages("summary")[0]).toEqual(
    shown,
  );
});

test("headless model-only instructions never enter durable messages or replay", async () => {
  const { runner } = fixture();
  const runInput = input("headless", "private-input");
  const shown: Message = {
    id: "visible",
    role: "user",
    content: "Visible request",
  };
  runInput.messages.push(shown);
  const agent = new AnswerAgent();
  await lastValueFrom(
    runner
      .run({
        threadId: "headless",
        agent,
        input: runInput,
        persistedInputMessages: [shown],
      })
      .pipe(toArray()),
  );
  expect(
    agent.received.some((message) => message.id === "user-private-input"),
  ).toBe(true);
  expect(
    runner
      .getThreadMessages("headless")
      .some((message) => message.id === "user-private-input"),
  ).toBe(false);
  const started = runner
    .getThreadEvents("headless")
    .find((event) => event.type === EventType.RUN_STARTED);
  expect(started?.threadId).toBe("headless");
  expect(JSON.stringify(started)).not.toContain("user-private-input");
});

test("a connected browser receives a running turn once and stop-before-start completes", async () => {
  const { runner } = fixture();
  const agent = new WaitingAgent();
  const running = lastValueFrom(
    runner
      .run({ threadId: "live", agent, input: input("live", "live-run") })
      .pipe(toArray()),
  );
  await agent.started.promise;
  await firstValueFrom(
    runner
      .connect({ threadId: "live" })
      .pipe(filter((event) => event.type === EventType.TEXT_MESSAGE_END)),
  );
  const connected = lastValueFrom(
    runner.connect({ threadId: "live" }).pipe(toArray()),
  );
  await runner.stop({ threadId: "live", runId: "live-run" });
  await running;
  const replay = await connected;
  expect(
    replay.filter((event) => event.type === EventType.RUN_STARTED),
  ).toHaveLength(1);
  expect(
    replay.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
  ).toHaveLength(1);
  const early = lastValueFrom(
    runner
      .run({
        threadId: "early",
        agent: new WaitingAgent(),
        input: input("early", "early-run"),
      })
      .pipe(toArray()),
  );
  await runner.stop({ threadId: "early", runId: "early-run" });
  expect((await early).at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(await runner.isRunning({ threadId: "early" })).toBe(false);
});
