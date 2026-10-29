import type { DeploymentConfig } from "./config";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLocalCallbackRequest(request: Request): boolean {
  if (request.headers.has("origin") || request.headers.get("upgrade"))
    return false;
  const { pathname } = new URL(request.url);
  return (
    (pathname === "/api/agent-tools/call" && request.method === "POST") ||
    pathname.startsWith("/api/model-provider/v1/")
  );
}

export function localRequestRefusal(
  request: Request,
  config: Pick<DeploymentConfig, "runtime" | "appUrl">,
): Response | undefined {
  if (config.runtime.mode !== "local") return;
  const target = new URL(request.url);
  const origin = request.headers.get("origin");
  const allowedOrigin =
    origin === null || origin === target.origin || origin === config.appUrl;
  if (
    (LOOPBACK_HOSTS.has(target.hostname) ||
      (target.hostname === "host.docker.internal" &&
        isLocalCallbackRequest(request))) &&
    allowedOrigin &&
    request.headers.get("sec-fetch-site") !== "cross-site"
  )
    return;
  return Response.json(
    { error: "Local access requires a trusted loopback origin and host." },
    { status: 403 },
  );
}
