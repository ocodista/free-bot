import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { type Browser, chromium } from "playwright-core";
import { mintRunAssertion } from "../server/src/agents/callback-token";
import { createDatabase } from "../server/src/db/client";
import { createRoutineStore } from "../server/src/routines/store";

const root = resolve(import.meta.dir, "..");
const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const output = join(root, ".free-bot", "verification", runId);
const temporary = mkdtempSync(join(tmpdir(), "free-bot-e2e-"));
const container = `free-bot-e2e-${runId}`;
const children: Bun.Subprocess[] = [];
const steps: { name: string; result: string; detail?: unknown }[] = [];
const browserErrors: string[] = [];
const blockedRequests: string[] = [];
const model = new LLMock({ host: "127.0.0.1", port: 0, strict: true });
let browser: Browser | undefined;
let fixtureDatabase: ReturnType<typeof createDatabase> | undefined;
let containerCreated = false;
let failure: string | undefined;
let cleanupFailure: string | undefined;
mkdirSync(output, { recursive: true });
mkdirSync(join(temporary, "home"), { recursive: true });

function check(name: string, detail?: unknown) {
  steps.push({
    name,
    result: "pass",
    ...(detail === undefined ? {} : { detail }),
  });
  console.info(JSON.stringify({ name, result: "pass" }));
}

async function command(
  args: string[],
  env?: Record<string, string>,
  cwd = root,
  logPath?: string,
) {
  const process = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (logPath)
    await Bun.write(logPath, `${stdout}\n${stderr}\nExit status: ${status}\n`);
  if (status !== 0)
    throw new Error(
      `${args.slice(0, 4).join(" ")} exited ${status}: ${stderr || stdout}`,
    );
  return stdout.trim();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function until<T>(
  name: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (ready(value)) return value;
      last = value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`${name} did not become ready: ${JSON.stringify(last)}`);
}

async function stop(child: Bun.Subprocess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5000);
  await child.exited;
  clearTimeout(timer);
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${text}`,
    );
  return JSON.parse(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value));
  return value;
}
const messageEnvelope = {
  parse(value: unknown) {
    const envelope = record(value);
    assert(Array.isArray(envelope.messages));
    return {
      messages: envelope.messages.map((value: unknown) => {
        const message = record(value);
        assert(
          typeof message.id === "string" && typeof message.role === "string",
        );
        return {
          ...message,
          id: message.id,
          role: message.role,
          content: message.content,
        };
      }),
    };
  },
};
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

try {
  const serverPort = await freePort();
  const appPort = await freePort();
  const callbackPort = await freePort();
  const api = `http://127.0.0.1:${serverPort}`;
  const app = `http://127.0.0.1:${appPort}`;
  const modelUrl = await model.start();
  model.onMessage(/.*/, {
    content: "FREEBOT_E2E_REPLY: local fixture completed.",
  });
  await command([
    "docker",
    "--context",
    "colima",
    "run",
    "--detach",
    "--name",
    container,
    "--memory=512m",
    "--cpus=1",
    "--publish",
    "127.0.0.1::5432",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--env",
    "POSTGRES_USER=freebot",
    "--env",
    "POSTGRES_PASSWORD=fixture-only",
    "--env",
    "POSTGRES_DB=freebot",
    "pgvector/pgvector:pg17",
  ]);
  containerCreated = true;
  const binding = await command([
    "docker",
    "--context",
    "colima",
    "port",
    container,
    "5432/tcp",
  ]);
  const databasePort = Number(binding.split(":").at(-1));
  assert(Number.isInteger(databasePort) && databasePort !== 5432);
  const databaseUrl = `postgres://freebot:fixture-only@127.0.0.1:${databasePort}/freebot`;
  await until(
    "disposable PostgreSQL",
    () =>
      command([
        "docker",
        "--context",
        "colima",
        "exec",
        container,
        "pg_isready",
        "--host",
        "127.0.0.1",
        "--username",
        "freebot",
        "--dbname",
        "freebot",
      ]),
    (value) => value.includes("accepting connections"),
  );
  check("created isolated PostgreSQL", {
    container,
    databasePort,
    memory: "512m",
    cpus: 1,
  });
  const modelOAuthFile = join(temporary, "model-oauth.json");
  await Bun.write(
    modelOAuthFile,
    JSON.stringify({
      version: 1,
      sessionId: crypto.randomUUID(),
      provider: "google",
      clientId: "synthetic-client",
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 3_600_000,
      scope: "fixture",
      quotaProject: "synthetic-quota-project",
      proxyToken: "synthetic-model-proxy-token",
    }),
  );
  chmodSync(modelOAuthFile, 0o600);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
    HOME: join(temporary, "home"),
    TMPDIR: temporary,
    NODE_ENV: "development",
    DATABASE_URL: databaseUrl,
    FREE_BOT_DATA_DIR: join(temporary, "data"),
    FREE_BOT_RUNTIME: "local",
    FREE_BOT_CALLBACK_PORT: String(callbackPort),
    AGENT_TOOL_TOKEN: "synthetic-agent-callback-token",
    OPENBOT_MODEL_OAUTH_FILE: modelOAuthFile,
    OPENBOT_SINGLE_USER: "true",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    TENANT_PACKAGE_DIR: join(root, "examples", "fintech"),
    PORT: String(serverPort),
    SERVER_PORT: String(serverPort),
    APP_PORT: String(appPort),
    TRUSTED_ORIGINS: app,
    OPENBOT_APP_URL: app,
    OPENBOT_PUBLIC_URL: api,
    OPENBOT_GENERATIVE_UI: "false",
    OPENBOT_SELF_HOST_BANNER: "false",
    OPENBOT_LEARNING_AUTO_ASSIGN: "false",
    OPENBOT_MEMORY_SOURCE_DEFAULTS: "false",
    OPENBOT_PROACTIVE_DEFAULTS: "false",
    OPENAI_BASE_URL: modelUrl,
    OPENAI_API_KEY: "synthetic-local-fixture-key",
    BOT_MODEL: "fixture-local-model",
    COPILOTKIT_TELEMETRY_DISABLED: "true",
    DO_NOT_TRACK: "1",
  };
  const migration = await command(
    [process.execPath, "--no-env-file", "server/scripts/migrate.ts"],
    env,
  );
  await Bun.write(join(output, "migration.log"), migration);
  check("applied migrations only to isolated PostgreSQL");
  await command(
    [process.execPath, "--no-env-file", "scripts/generate-app-config.ts"],
    env,
  );
  await command(
    [
      process.execPath,
      "--no-env-file",
      "test",
      "server/tests/tenant-package.test.ts",
    ],
    { ...env, TEST_DATABASE_URL: databaseUrl },
    root,
    join(output, "tenant-package-test.log"),
  );
  check(
    "related tenant-package database tests pass against disposable PostgreSQL",
    {
      command: "bun --no-env-file test server/tests/tenant-package.test.ts",
      exitStatus: 0,
      log: join(output, "tenant-package-test.log"),
    },
  );
  let generation = 0;
  const launchServer = () => {
    generation += 1;
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "server/src/index.ts"],
      {
        cwd: root,
        env,
        stdout: Bun.file(join(output, `server-${generation}.log`)),
        stderr: Bun.file(join(output, `server-${generation}-stderr.log`)),
      },
    );
    children.push(child);
    return child;
  };
  let server = launchServer();
  const ready = async () => {
    try {
      return await until(
        "full server startup",
        () => json(`${api}/api/capabilities`),
        (value) => record(value).mode === "local",
      );
    } catch (error) {
      throw new Error(
        `${String(error)}; server exit=${server.exitCode}; log=${join(output, `server-${generation}-stderr.log`)}`,
      );
    }
  };
  const capabilities = await ready();
  check(
    "full server starts with local durable runtime and no hosted credential",
    capabilities,
  );
  const me = record(await json(`${api}/api/me`));
  assert.equal(record(me.user).id, "dev-local-user");
  assert.equal(record(me.user).role, "admin");
  check("cookie-free local administrator access", me);
  const info = record(await json(`${api}/api/copilotkit/info`));
  assert.equal(info.mode, "sse");
  assert("general-assistant" in record(info.agents));
  check("supported SSE runtime exposes local agent roster");
  const callbackEvidence: {
    target: string;
    path: string;
    host: string;
    status: number;
    response: string;
  }[] = [];
  const callbackRequest = async (
    target: string,
    path: string,
    headers: Record<string, string> = {},
    body: unknown = {},
  ) => {
    const serialized = JSON.stringify(body);
    const host = `host.docker.internal:${callbackPort}`;
    const request = [
      `POST ${path} HTTP/1.1`,
      `Host: ${host}`,
      "Connection: close",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(serialized)}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      "",
      serialized,
    ].join("\r\n");
    const response = await command([
      "docker",
      "--context",
      "colima",
      "exec",
      container,
      "timeout",
      "5",
      "bash",
      "-c",
      'exec 3<>/dev/tcp/"$1"/"$2"; printf "%s" "$3" >&3; cat <&3',
      "fixture-callback",
      target,
      String(callbackPort),
      request,
    ]);
    const match = response.match(/^HTTP\/1\.[01] (\d+)/);
    assert(match?.[1], `No HTTP callback response from ${target}: ${response}`);
    const status = Number(match[1]);
    callbackEvidence.push({ target, path, host, status, response });
    await Bun.write(
      join(output, "callback-network.json"),
      JSON.stringify({ callbackPort, requests: callbackEvidence }, null, 2),
    );
    return { status, response };
  };
  let callbackTarget: string | undefined;
  const connectionFailures: string[] = [];
  for (const target of ["host.docker.internal", "host.lima.internal"]) {
    try {
      const denied = await callbackRequest(target, "/api/agent-tools/call", {
        "x-openbot-agent-token": "wrong-token",
      });
      assert.equal(denied.status, 401, denied.response);
      callbackTarget = target;
      break;
    } catch (error) {
      connectionFailures.push(
        `${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  assert(
    callbackTarget,
    `Docker fixture cannot reach private callback listener: ${connectionFailures.join("; ")}`,
  );
  const signedRun = mintRunAssertion(
    {
      botId: "general-assistant",
      actorId: "dev-local-user",
      runId: crypto.randomUUID(),
    },
    env.KEY_ENCRYPTION_KEY,
  );
  const wrongToolToken = await callbackRequest(
    callbackTarget,
    "/api/agent-tools/call",
    { "x-openbot-agent-token": "wrong-token" },
    { run: signedRun },
  );
  assert.equal(wrongToolToken.status, 401, wrongToolToken.response);
  const authenticated = await callbackRequest(
    callbackTarget,
    "/api/agent-tools/call",
    { "x-openbot-agent-token": env.AGENT_TOOL_TOKEN },
    { run: signedRun },
  );
  assert.equal(authenticated.status, 400, authenticated.response);
  assert(
    authenticated.response.includes("A tool is required."),
    authenticated.response,
  );
  const wrongAssertion = await callbackRequest(
    callbackTarget,
    "/api/agent-tools/call",
    { "x-openbot-agent-token": env.AGENT_TOOL_TOKEN },
    { run: "invalid-assertion" },
  );
  assert.equal(wrongAssertion.status, 401, wrongAssertion.response);
  const badModelToken = await callbackRequest(
    callbackTarget,
    "/api/model-provider/v1/chat/completions",
    { authorization: "Bearer wrong-token" },
  );
  assert.equal(badModelToken.status, 401, badModelToken.response);
  const validModelToken = await callbackRequest(
    callbackTarget,
    "/api/model-provider/v1/chat/completions",
    { authorization: "Bearer synthetic-model-proxy-token" },
  );
  assert.equal(validModelToken.status, 400, validModelToken.response);
  assert(
    validModelToken.response.includes("unsupported or invalid content"),
    validModelToken.response,
  );
  for (const path of ["/api/me", "/api/copilotkit/threads/clear"]) {
    const denied = await callbackRequest(callbackTarget, path, {
      "x-openbot-agent-token": env.AGENT_TOOL_TOKEN,
    });
    assert([403, 404].includes(denied.status), denied.response);
  }
  const originDenied = await callbackRequest(
    callbackTarget,
    "/api/agent-tools/call",
    { origin: app, "x-openbot-agent-token": env.AGENT_TOOL_TOKEN },
    { run: signedRun },
  );
  assert.equal(originDenied.status, 403, originDenied.response);
  const localAdminDenied = await fetch(
    `http://127.0.0.1:${callbackPort}/api/me`,
    { headers: { host: `localhost:${callbackPort}` } },
  );
  assert([403, 404].includes(localAdminDenied.status));
  await Bun.write(
    join(output, "callback-network.json"),
    JSON.stringify(
      {
        callbackPort,
        callbackTarget,
        connectionFailures,
        requests: callbackEvidence,
        localAdminStatus: localAdminDenied.status,
      },
      null,
      2,
    ),
  );
  check("real Docker callbacks require service credentials and signed run", {
    target: callbackTarget,
    callbackPort,
    validToolStatus: authenticated.status,
    wrongToolStatus: 401,
    wrongAssertionStatus: wrongAssertion.status,
  });
  check(
    "real Docker model proxy requires local bearer and rejects malformed requests before upstream",
    {
      wrongTokenStatus: badModelToken.status,
      validTokenStatus: validModelToken.status,
      providerCalls: 0,
    },
  );
  check(
    "private callback listener refuses administrator APIs and browser origins",
    { originStatus: originDenied.status, adminStatus: localAdminDenied.status },
  );
  const channel = record(
    record(
      await json(
        `${api}/api/channels`,
        post({ agentIds: ["general-assistant"] }),
      ),
    ).channel,
  );
  assert(
    typeof channel.id === "string" && typeof channel.threadId === "string",
  );
  const channelId = channel.id;
  const threadId = channel.threadId;
  const run = async (marker: string) => {
    const response = await fetch(
      `${api}/api/copilotkit/agent/general-assistant/run`,
      {
        ...post({
          threadId: threadId,
          runId: crypto.randomUUID(),
          state: {},
          messages: [
            { id: crypto.randomUUID(), role: "user", content: marker },
          ],
          tools: [],
          context: [],
          forwardedProps: {},
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    const events = await response.text();
    await Bun.write(join(output, `${marker}.sse`), events);
    assert.equal(response.status, 200, events);
    assert(events.includes("FREEBOT_E2E_REPLY"), events);
    assert(!events.includes('"type":"RUN_ERROR"'), events);
  };
  await run("FREEBOT_API_FIRST");
  const historyUrl = `${api}/api/copilotkit/threads/${threadId}/messages?agentId=general-assistant`;
  const first = messageEnvelope.parse(await json(historyUrl));
  assert(
    first.messages.some((message) => message.content === "FREEBOT_API_FIRST"),
  );
  assert(
    first.messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("FREEBOT_E2E_REPLY"),
    ),
  );
  check("real chat request produces response and native persisted history", {
    threadId: threadId,
    messages: first.messages.length,
  });
  await stop(server);
  server = launchServer();
  await ready();
  assert.deepEqual(
    messageEnvelope.parse(await json(historyUrl)).messages,
    first.messages,
  );
  check("full server restart preserves messages");
  await run("FREEBOT_API_SECOND");
  const secondRequest = model
    .getRequests()
    .find((entry) => JSON.stringify(entry.body).includes("FREEBOT_API_SECOND"));
  assert(secondRequest);
  assert(JSON.stringify(secondRequest.body).includes("FREEBOT_API_FIRST"));
  assert(JSON.stringify(secondRequest.body).includes("FREEBOT_E2E_REPLY"));
  check("second model turn receives persisted first-turn history");
  fixtureDatabase = createDatabase(databaseUrl, { max: 1 });
  const routine = await createRoutineStore(fixtureDatabase).create({
    ownerUserId: "dev-local-user",
    agentId: "general-assistant",
    channelId: channelId,
    instruction: "FREEBOT_BACKGROUND_ROUTINE",
    cron: "0 0 1 1 *",
    timezone: "UTC",
  });
  await json(`${api}/api/routines/${routine.id}/run`, { method: "POST" });
  const routineRuns = await until(
    "background routine",
    () => json(`${api}/api/routines/${routine.id}/runs`),
    (value) => {
      const runs = record(value).runs;
      return (
        Array.isArray(runs) &&
        runs.length > 0 &&
        runs.every((run: unknown) => record(run).status === "succeeded")
      );
    },
  );
  const backgroundHistory = messageEnvelope.parse(await json(historyUrl));
  assert(
    JSON.stringify(backgroundHistory).includes("FREEBOT_BACKGROUND_ROUTINE"),
  );
  assert(backgroundHistory.messages.length > first.messages.length + 2);
  check(
    "real background routine shares durable runner with browser endpoints",
    routineRuns,
  );
  await command(
    [process.execPath, "--no-env-file", "scripts/generate-app-config.ts"],
    env,
  );
  const vite = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--bun",
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(appPort),
      "--strictPort",
    ],
    {
      cwd: join(root, "app"),
      env,
      stdout: Bun.file(join(output, "vite.log")),
      stderr: Bun.file(join(output, "vite-stderr.log")),
    },
  );
  children.push(vite);
  await until(
    "isolated Vite app",
    async () => (await fetch(app)).status,
    (status) => status === 200,
  );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      ["data:", "blob:"].includes(url.protocol)
    )
      await route.continue();
    else {
      blockedRequests.push(url.origin);
      await route.abort();
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(app, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: /Welcome to/ })
    .waitFor({ timeout: 45_000 });
  assert(!page.url().includes("/sign"));
  await page.screenshot({
    path: join(output, "no-login-welcome.png"),
    fullPage: true,
    animations: "disabled",
  });
  check("fresh real browser reaches onboarding without third-party login");
  await json(`${api}/api/me/onboarding`, post({ completed: true }));
  await page.goto(`${app}/channel/${channelId}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor({ timeout: 45_000 });
  await page
    .getByRole("main")
    .getByText("FREEBOT_E2E_REPLY: local fixture completed.", { exact: true })
    .last()
    .waitFor({ timeout: 30_000 });
  await page
    .getByRole("main")
    .getByText("FREEBOT_API_FIRST", { exact: true })
    .waitFor({ timeout: 30_000 });
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("FREEBOT_UI_THIRD");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .press("Enter");
  await until(
    "browser message persisted",
    async () => messageEnvelope.parse(await json(historyUrl)),
    (value) =>
      value.messages.some((message) => message.content === "FREEBOT_UI_THIRD"),
  );
  await until(
    "browser answer persisted",
    async () => messageEnvelope.parse(await json(historyUrl)),
    (value) =>
      value.messages.filter((message) => message.role === "assistant").length >=
      4,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("main")
    .getByText("FREEBOT_UI_THIRD", { exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await page
    .getByRole("main")
    .getByText("FREEBOT_E2E_REPLY: local fixture completed.", { exact: true })
    .last()
    .waitFor({ timeout: 30_000 });
  await page
    .getByRole("main")
    .getByText("FREEBOT_E2E_REPLY: local fixture completed.", { exact: true })
    .last()
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(output, "chat-after-reload.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(browserErrors, []);
  check("real browser sends chat and restores history after reload");
  await Bun.write(
    join(output, "model-requests.json"),
    JSON.stringify(model.getRequests(), null, 2),
  );
} catch (error) {
  failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
    for (const child of children.reverse()) await stop(child);
    await fixtureDatabase?.$client.close();
    await model.stop();
    if (containerCreated)
      await command([
        "docker",
        "--context",
        "colima",
        "rm",
        "--force",
        "--volumes",
        container,
      ]);
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  const report = {
    status: failure || cleanupFailure ? "failed" : "passed",
    command: "bun --no-env-file scripts/free-bot-e2e.ts",
    startedAt: new Date(Number(runId.split("-")[0])).toISOString(),
    finishedAt: new Date().toISOString(),
    isolated: {
      temporaryHome: true,
      disposablePostgres: container,
      model: "local LLMock",
      paidApiCalls: false,
      inheritedCredentials: false,
    },
    steps,
    browserErrors,
    blockedRequests,
    failure,
    cleanupFailure,
    artifacts: output,
  };
  await Bun.write(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.info(
    JSON.stringify({
      status: report.status,
      report: join(output, "report.json"),
    }),
  );
}
