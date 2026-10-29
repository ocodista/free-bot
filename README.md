# Free-bot

Free-bot is a local fork of [CopilotKit OpenBot](https://github.com/CopilotKit/openbot). Open the workspace, chat, keep conversations, and run background routines without a CopilotKit account, project key, license token, or third-party sign-in.

Local mode runs the open-source CopilotKit SSE runtime with durable SQLite conversation storage. PostgreSQL keeps agents, settings, routines, permissions, and local memory. Browser chats, routines, and handoffs share one runner and transcript store.

Model providers and optional integrations keep their own credentials. A paid model still costs money; an OpenAI-compatible local model can run through a local endpoint. Hosted Intelligence Learning is optional and is not part of local mode.

## Quick start

You need Bun 1.4+ and Docker for the database. This fork uses its own Compose project, data directory, and ports.

```sh
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres
bun run --cwd server db:migrate
bun run dev
```

Open [Free-bot](http://localhost:3030). First-run onboarding lets you configure a model provider without signing into Free-bot or CopilotKit.

For the complete optional stack, including browser computers and framework agents, use `bun run start` after the database migration. Those components need Docker and their own model credentials. Existing provider setup is described in [the documentation](docs/README.md).

## Local configuration

`.env.example` selects `OPENBOT_RUNTIME=local` and `OPENBOT_SINGLE_USER=true`. The API listens on `127.0.0.1:3031`, the app on port 3030, and the database on loopback port 55432. The Compose project is `free-bot`; it does not reuse an existing OpenBot database volume. Port 3032 is a separate container callback listener: it exposes only the existing authenticated tool and model-proxy routes, and refuses ordinary app APIs and browser origins.

Conversations live at `.free-bot/conversations.sqlite`. Set `FREE_BOT_DATA_DIR` to choose another directory. Keep this directory and the PostgreSQL volume when backing up the workspace. API keys remain in the existing encrypted credential store.

To use an OpenAI-compatible endpoint, configure `OPENAI_BASE_URL`, `BOT_PROVIDER=openai`, and `BOT_MODEL`. Supply whatever credential that endpoint requires. The browser onboarding and provider settings remain available for normal API-key setup.

Local mode serves one local administrator. It requires loopback origins, refuses organization/OAuth authentication settings, and rejects untrusted browser origins and hosts. Use the configured app URL consistently; a reverse proxy or multi-user deployment needs a separately configured authenticated mode.

An interrupted process can leave a conversation lease for up to 120 seconds. Retry after that lease expires. Completed, stopped, and failed turns release their leases immediately.

## Desktop source launcher

```sh
cd desktop
bun install --frozen-lockfile
bun run tauri dev
```

This requires the normal Rust/Tauri desktop build tools. Local mode is selected by default and enables Start without a platform account. A debug build copies this fork's deployment source into `~/FreeBot`, excluding credentials and user data; its application profile is separate from OpenBot. The optional Intelligence connection remains available under advanced settings.

Desktop setup UI tests, native environment/source-copy tests, TypeScript, the UI build, and native binary compilation passed. A full native application launch and signed installer publication have not been verified. Release builds acquire deployment archives from the fork's releases, so distributable installers require publishing those fork assets first.

## Optional Intelligence mode

Existing authenticated deployments can explicitly select `OPENBOT_RUNTIME=intelligence` and provide `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, and `INTELLIGENCE_API_KEY`, plus their normal sign-in configuration. That service retains its own account and entitlement requirements. Local mode does not call its login, Learning setup, or entitlement endpoints.

The upstream architecture and integration guides under `docs/` describe OpenBot's broader feature set. References there to mandatory Intelligence apply to the upstream/hosted mode; follow this README for the account-free fork.

## Verification

```sh
bun run test:local
bun test scripts/start-restart-guard.test.ts
bun run --cwd server typecheck
bun run test:local-e2e
```

The end-to-end fixture creates a fresh database container, disposable home and conversation directory, local fake model, and independent browser profile. It exercises the actual server, chat, restart, background routine, and browser UI without touching a running OpenBot installation or real model accounts. It requires Docker and Chrome/Chromium. Reports, logs, and screenshots go under `.free-bot/verification/`; the fixture removes only its own processes and temporary data.

## Upstream and license

Based on CopilotKit OpenBot commit `12c3a69406b2ca32bcb117c0329c9c6d9359565d`. Original copyright and [MIT license](LICENSE) are retained. Existing internal `openbot` package names and protocol identifiers preserve compatibility.
