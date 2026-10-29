import { expect, test } from "bun:test";
import { startLocalCallbackServer } from "../src/local-callback-server";

test("the container listener cannot expose ordinary local API or browser requests", async () => {
  const forwarded: string[] = [];
  const server = startLocalCallbackServer(0, (request) => {
    forwarded.push(new URL(request.url).pathname);
    return Response.json({ handled: true });
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of [
      "/api/me",
      "/api/copilotkit/threads/clear",
      "/health",
    ]) {
      expect(
        (
          await fetch(base + path, {
            method: "POST",
            headers: { host: "localhost" },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await fetch(`${base}/api/agent-tools/call`, {
          method: "POST",
          headers: { origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect(forwarded).toEqual([]);
    expect(
      (await fetch(`${base}/api/agent-tools/call`, { method: "POST" })).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/api/model-provider/v1/responses`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(forwarded).toEqual([
      "/api/agent-tools/call",
      "/api/model-provider/v1/responses",
    ]);
  } finally {
    server.stop(true);
  }
});
