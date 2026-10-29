import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type AbstractAgent,
  type BaseEvent,
  compactEvents,
  EventType,
  type Message,
} from "@ag-ui/client";
import {
  EventSchema,
  MessageSchema,
  RunAgentInputSchema,
} from "@ag-ui/core/schemas";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  CopilotKitIntelligence,
  type CreateThreadRequest,
  finalizeRunEvents,
  type LocalThreadEndpointRunner,
} from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject, Subject } from "rxjs";
import { z } from "zod";

const LOCAL_USER_ID = "dev-local-user";
const threadSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  user_id: z.string(),
  name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  messages: z.string(),
});
const lockSchema = z.object({ run_id: z.string(), expires_at: z.number() });
const eventRowSchema = z.object({ payload: z.string() });
const messagesSchema = MessageSchema.array();
type ThreadRow = z.infer<typeof threadSchema>;

export class LocalRuntimeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LocalRuntimeError";
  }
}

type ActiveRun = {
  runId: string;
  agent: AbstractAgent;
  output: ReplaySubject<BaseEvent>;
  live: Subject<BaseEvent>;
  stopping: boolean;
  cancel: () => void;
};

function mergedMessages(previous: Message[], incoming: Message[]): Message[] {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()];
}

export class LocalAgentRunner
  extends AgentRunner
  implements LocalThreadEndpointRunner
{
  readonly ɵsupportsLocalThreadEndpoints = true;
  private readonly database: Database;
  private readonly active = new Map<string, ActiveRun>();

  constructor(path: string) {
    super();
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
        name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, sequence);
      CREATE TABLE IF NOT EXISTS locks (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    this.database
      .query("DELETE FROM locks WHERE expires_at <= ?")
      .run(Date.now());
  }

  private row(threadId: string): ThreadRow | undefined {
    const row = this.database
      .query("SELECT * FROM threads WHERE id = ?")
      .get(threadId);
    return row === null ? undefined : threadSchema.parse(row);
  }

  private assertUser(userId: string): void {
    if (userId !== LOCAL_USER_ID)
      throw new LocalRuntimeError(
        "Local runtime admits only the local user.",
        403,
      );
  }

  thread(threadId: string, userId: string) {
    this.assertUser(userId);
    const row = this.row(threadId);
    if (!row) throw new LocalRuntimeError("Thread not found.", 404);
    return {
      id: row.id,
      name: row.name,
      agentId: row.agent_id,
      createdById: row.user_id,
      organizationId: "local",
      archived: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createThread(input: CreateThreadRequest) {
    this.assertUser(input.userId);
    if (this.row(input.threadId))
      throw new LocalRuntimeError("Thread already exists.", 409);
    const now = new Date().toISOString();
    this.database
      .query(
        "INSERT INTO threads (id,agent_id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        input.threadId,
        input.agentId,
        input.userId,
        input.name ?? null,
        now,
        now,
      );
    return this.thread(input.threadId, input.userId);
  }

  ensureThread(input: CreateThreadRequest) {
    const existing = this.row(input.threadId);
    if (!existing) return { thread: this.createThread(input), created: true };
    this.assertUser(input.userId);
    if (existing.agent_id !== input.agentId)
      throw new LocalRuntimeError("Thread belongs to another agent.", 403);
    return {
      thread: this.thread(input.threadId, input.userId),
      created: false,
    };
  }

  acquire(input: Parameters<CopilotKitIntelligence["ɵacquireThreadLock"]>[0]) {
    this.ensureThread(input);
    const ttlSeconds = input.ttlSeconds ?? 120;
    return this.database.transaction(() => {
      const value = this.database
        .query("SELECT run_id,expires_at FROM locks WHERE thread_id=?")
        .get(input.threadId);
      if (value !== null) {
        const lock = lockSchema.parse(value);
        if (
          lock.run_id !== input.runId &&
          (lock.expires_at > Date.now() || this.active.has(input.threadId))
        )
          throw new LocalRuntimeError("Thread is already running.", 409);
      }
      const running = this.active.get(input.threadId);
      if (running && running.runId !== input.runId)
        throw new LocalRuntimeError("Thread is already running.", 409);
      this.database
        .query(
          "INSERT INTO locks(thread_id,run_id,expires_at) VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET run_id=excluded.run_id,expires_at=excluded.expires_at",
        )
        .run(input.threadId, input.runId, Date.now() + ttlSeconds * 1000);
      return {
        threadId: input.threadId,
        runId: input.runId,
        joinToken: "local",
      };
    })();
  }

  renew(input: Parameters<CopilotKitIntelligence["ɵrenewThreadLock"]>[0]) {
    const result = this.database
      .query("UPDATE locks SET expires_at=? WHERE thread_id=? AND run_id=?")
      .run(Date.now() + input.ttlSeconds * 1000, input.threadId, input.runId);
    if (!result.changes)
      throw new LocalRuntimeError("Run lock is no longer held.", 409);
    return { ttlSeconds: input.ttlSeconds };
  }

  release(
    input: Parameters<CopilotKitIntelligence["ɵcleanupThreadLock"]>[0],
  ): void {
    if (this.active.get(input.threadId)?.runId === input.runId) return;
    this.database
      .query("DELETE FROM locks WHERE thread_id=? AND run_id=?")
      .run(input.threadId, input.runId);
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const input = RunAgentInputSchema.parse(request.input);
    const incoming = messagesSchema.parse(
      request.persistedInputMessages ?? input.messages,
    );
    if (input.threadId !== request.threadId)
      throw new LocalRuntimeError("Run thread does not match.", 400);
    if (this.active.has(request.threadId))
      throw new LocalRuntimeError("Thread is already running.", 409);
    this.acquire({
      threadId: request.threadId,
      userId: LOCAL_USER_ID,
      agentId: request.agent.agentId ?? "default",
      runId: input.runId,
    });
    const cancellation = Promise.withResolvers<void>();
    const run: ActiveRun = {
      runId: input.runId,
      agent: request.agent,
      output: new ReplaySubject<BaseEvent>(),
      live: new Subject<BaseEvent>(),
      stopping: false,
      cancel: cancellation.resolve,
    };
    this.active.set(request.threadId, run);
    const history = this.getThreadMessages(request.threadId);
    const retainedIds = new Set(
      [...history, ...incoming].map((message) => message.id),
    );
    const modelOnlyIds = new Set(
      input.messages
        .filter((message) => !retainedIds.has(message.id))
        .map((message) => message.id),
    );
    const storedInput = mergedMessages(history, incoming);
    const persistedVersions = new Map(
      request.persistedInputMessages === undefined
        ? []
        : storedInput.map((message) => [message.id, message]),
    );
    const visibleMessages = (messages: Message[]) =>
      messages
        .filter((message) => !modelOnlyIds.has(message.id))
        .map((message) => persistedVersions.get(message.id) ?? message);
    this.saveMessages(request.threadId, storedInput);
    request.agent.threadId = request.threadId;
    request.agent.setMessages(
      request.persistedInputMessages === undefined
        ? mergedMessages(history, input.messages)
        : input.messages,
    );
    request.agent.setState(input.state);
    const events: BaseEvent[] = [];
    const publish = (event: BaseEvent) => {
      this.database
        .query("INSERT INTO events(thread_id,payload) VALUES(?,?)")
        .run(request.threadId, JSON.stringify(event));
      run.output.next(event);
      run.live.next(event);
    };
    const execute = async () => {
      let failure: string | undefined;
      try {
        if (!run.stopping)
          await Promise.race([
            request.agent.runAgent(input, {
              onEvent: ({ event }) => {
                if (run.stopping) return;
                const parsed = EventSchema.parse(event);
                const next =
                  parsed.type === EventType.RUN_STARTED
                    ? {
                        ...parsed,
                        input: {
                          ...input,
                          messages: incoming.filter(
                            (message) =>
                              !history.some(
                                (previous) => previous.id === message.id,
                              ),
                          ),
                        },
                      }
                    : parsed.type === EventType.MESSAGES_SNAPSHOT
                      ? {
                          ...parsed,
                          messages: visibleMessages(parsed.messages),
                        }
                      : parsed;
                events.push(next);
                if (
                  next.type !== EventType.RUN_FINISHED &&
                  next.type !== EventType.RUN_ERROR
                ) {
                  this.saveMessages(
                    request.threadId,
                    mergedMessages(
                      storedInput,
                      visibleMessages(request.agent.messages),
                    ),
                  );
                  publish(next);
                }
              },
              onMessagesChanged: ({ messages }) => {
                if (!run.stopping)
                  this.saveMessages(
                    request.threadId,
                    mergedMessages(
                      this.getThreadMessages(request.threadId),
                      visibleMessages(messagesSchema.parse(messages)),
                    ),
                  );
              },
            }),
            cancellation.promise,
          ]);
      } catch (error) {
        failure =
          error instanceof Error ? error.message : "Local agent failed.";
      }
      try {
        if (!events.some((event) => event.type === EventType.RUN_STARTED)) {
          const started: BaseEvent = {
            type: EventType.RUN_STARTED,
            threadId: request.threadId,
            runId: input.runId,
            input: { ...input, messages: incoming },
          };
          events.unshift(started);
          publish(started);
        }
        const appended = finalizeRunEvents(events, {
          stopRequested: run.stopping,
          protocolVersion: input.protocolVersion,
          ...(failure ? { interruptionMessage: failure } : {}),
        });
        this.saveMessages(
          request.threadId,
          mergedMessages(
            this.getThreadMessages(request.threadId),
            visibleMessages(request.agent.messages),
          ),
        );
        for (const event of appended)
          if (
            event.type !== EventType.RUN_FINISHED &&
            event.type !== EventType.RUN_ERROR
          )
            publish(event);
        for (const event of events)
          if (
            event.type === EventType.RUN_FINISHED ||
            event.type === EventType.RUN_ERROR
          )
            publish(event);
        this.active.delete(request.threadId);
        this.release({ threadId: request.threadId, runId: input.runId });
        run.output.complete();
        run.live.complete();
      } catch (error) {
        this.active.delete(request.threadId);
        this.release({ threadId: request.threadId, runId: input.runId });
        run.output.error(error);
        run.live.error(error);
      }
    };
    queueMicrotask(() => {
      void execute();
    });
    return run.output.asObservable();
  }

  private saveMessages(threadId: string, messages: Message[]): void {
    this.database
      .query("UPDATE threads SET messages=?, updated_at=? WHERE id=?")
      .run(
        JSON.stringify(messagesSchema.parse(messages)),
        new Date().toISOString(),
        threadId,
      );
  }

  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const row = this.row(request.threadId);
    if (row && request.agentId && request.agentId !== row.agent_id)
      throw new LocalRuntimeError("Thread belongs to another agent.", 403);
    return new Observable((subscriber) => {
      for (const event of this.getThreadEvents(request.threadId))
        subscriber.next(event);
      const run = this.active.get(request.threadId);
      if (!run) {
        subscriber.complete();
        return;
      }
      return run.live.subscribe(subscriber);
    });
  }

  override async isRunning(request: { threadId: string }): Promise<boolean> {
    return this.active.has(request.threadId);
  }

  override async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const run = this.active.get(request.threadId);
    if (
      !run ||
      run.stopping ||
      (request.runId !== undefined && request.runId !== run.runId)
    )
      return false;
    run.stopping = true;
    run.agent.abortRun();
    run.cancel();
    return true;
  }

  listThreads() {
    return this.database
      .query("SELECT * FROM threads ORDER BY updated_at DESC")
      .all()
      .map((value) => {
        const row = threadSchema.parse(value);
        return this.thread(row.id, row.user_id);
      });
  }

  getThreadMessages(threadId: string): Message[] {
    const row = this.row(threadId);
    return row ? messagesSchema.parse(JSON.parse(row.messages)) : [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    return compactEvents(
      this.database
        .query("SELECT payload FROM events WHERE thread_id=? ORDER BY sequence")
        .all(threadId)
        .map((value) =>
          EventSchema.parse(JSON.parse(eventRowSchema.parse(value).payload)),
        ),
    );
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    for (const event of this.getThreadEvents(threadId).reverse())
      if (event.type === EventType.STATE_SNAPSHOT)
        return z.record(z.string(), z.unknown()).parse(event.snapshot);
    return null;
  }

  clearThreads(): void {
    if (this.active.size)
      throw new LocalRuntimeError("Cannot clear running conversations.", 409);
    this.database.exec("DELETE FROM threads");
  }

  close(): void {
    if (this.active.size)
      throw new LocalRuntimeError("Cannot close running conversations.", 409);
    this.database.close();
  }
}

export class LocalIntelligenceClient extends CopilotKitIntelligence {
  constructor(private readonly runner: LocalAgentRunner) {
    super({
      apiUrl: "http://127.0.0.1:1",
      wsUrl: "ws://127.0.0.1:1",
      apiKey: "local-runtime",
    });
  }
  override async createThread(input: CreateThreadRequest) {
    return this.runner.createThread(input);
  }
  override async getThread(
    input: Parameters<CopilotKitIntelligence["getThread"]>[0],
  ) {
    return this.runner.thread(input.threadId, input.userId);
  }
  override async getOrCreateThread(input: CreateThreadRequest) {
    return this.runner.ensureThread(input);
  }
  override async getThreadMessages(
    input: Parameters<CopilotKitIntelligence["getThreadMessages"]>[0],
  ) {
    this.runner.thread(input.threadId, input.userId);
    return {
      messages: this.runner
        .getThreadMessages(input.threadId)
        .map((message) => ({
          ...message,
          ...(message.role === "assistant" && message.toolCalls
            ? {
                toolCalls: message.toolCalls.map((call) => ({
                  id: call.id,
                  name: call.function.name,
                  args: call.function.arguments,
                })),
              }
            : { toolCalls: undefined }),
        })),
    };
  }
  override async ɵacquireThreadLock(
    input: Parameters<CopilotKitIntelligence["ɵacquireThreadLock"]>[0],
  ) {
    return this.runner.acquire(input);
  }
  override async ɵrenewThreadLock(
    input: Parameters<CopilotKitIntelligence["ɵrenewThreadLock"]>[0],
  ) {
    return this.runner.renew(input);
  }
  override async ɵcleanupThreadLock(
    input: Parameters<CopilotKitIntelligence["ɵcleanupThreadLock"]>[0],
  ): Promise<void> {
    this.runner.release(input);
  }
}

const runtimes = new Map<
  string,
  { runner: LocalAgentRunner; client: LocalIntelligenceClient }
>();

export function getLocalRuntime(path: string) {
  const resolved = resolve(path);
  const cached = runtimes.get(resolved);
  if (cached) return cached;
  const runner = new LocalAgentRunner(resolved);
  const runtime = { runner, client: new LocalIntelligenceClient(runner) };
  runtimes.set(resolved, runtime);
  return runtime;
}

export function closeLocalRuntime(path: string): void {
  const resolved = resolve(path);
  const runtime = runtimes.get(resolved);
  if (!runtime) return;
  runtime.runner.close();
  runtimes.delete(resolved);
}
