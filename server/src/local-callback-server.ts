import { isLocalCallbackRequest } from "./local-access";

export function startLocalCallbackServer(
  port: number,
  handle: (request: Request) => Response | Promise<Response>,
) {
  return Bun.serve({
    hostname: "0.0.0.0",
    port,
    idleTimeout: 255,
    fetch(request) {
      if (!isLocalCallbackRequest(request)) {
        return Response.json(
          {
            error: "This listener accepts authenticated agent callbacks only.",
          },
          { status: 403 },
        );
      }
      return handle(request);
    },
  });
}
