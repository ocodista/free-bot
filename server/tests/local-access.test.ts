import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { localRequestRefusal } from "../src/local-access";
import { closeLocalRuntime, getLocalRuntime } from "../src/local-runtime";

const fixtures: { path: string; directory: string }[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    closeLocalRuntime(fixture.path);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "free-bot-access-"));
  const config = loadConfig({
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    FREE_BOT_DATA_DIR: directory,
    TRUSTED_ORIGINS: "http://localhost:3030",
  });
  if (config.runtime.mode !== "local") throw new Error("Expected local mode");
  fixtures.push({ path: config.runtime.path, directory });
  const { runner, client } = getLocalRuntime(config.runtime.path);
  await client.createThread({
    threadId: "retained",
    agentId: "assistant",
    userId: "dev-local-user",
  });
  const runtime = new CopilotRuntime({
    agents: {
      assistant: new HttpAgent({
        agentId: "assistant",
        url: "http://127.0.0.1:1",
      }),
    },
    runner,
  });
  const app = createApp(
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" }),
  );
  return { app, runner };
}

test("a cross-site form cannot clear durable local conversations", async () => {
  const { app, runner } = await fixture();
  const response = await app.request(
    "http://localhost:3031/api/copilotkit/threads/clear",
    {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "confirm=yes",
    },
  );
  expect(response.status).toBe(403);
  expect(runner.listThreads()).toHaveLength(1);
});

test("DNS rebinding and null origins cannot read the local API", async () => {
  const { app } = await fixture();
  expect(
    (await app.request("http://attacker.example/api/capabilities")).status,
  ).toBe(403);
  expect(
    (
      await app.request("http://localhost:3031/api/capabilities", {
        headers: { origin: "null" },
      })
    ).status,
  ).toBe(403);
});

test("the configured local app and command-line requests can use the API", async () => {
  const { app, runner } = await fixture();
  const capabilities = await app.request(
    "http://localhost:3031/api/capabilities",
    {
      headers: {
        origin: "http://localhost:3030",
        "sec-fetch-site": "same-site",
      },
    },
  );
  expect(capabilities.status).toBe(200);
  expect(await capabilities.json()).toMatchObject({
    mode: "local",
    durableHistory: true,
  });
  const response = await app.request(
    "http://localhost:3031/api/copilotkit/threads/clear",
    { method: "POST" },
  );
  expect(response.status).toBe(204);
  expect(runner.listThreads()).toHaveLength(0);
});

test("the Docker host alias only reaches authenticated callback routes", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  });
  expect(
    localRequestRefusal(
      new Request("http://host.docker.internal:3032/api/agent-tools/call", {
        method: "POST",
      }),
      config,
    ),
  ).toBeUndefined();
  expect(
    localRequestRefusal(
      new Request("http://host.docker.internal:3032/api/me"),
      config,
    )?.status,
  ).toBe(403);
});
