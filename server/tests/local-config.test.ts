import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const localEnvironment = {
  DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:15432/fixture",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

describe("account-free local configuration", () => {
  test("starts with no account, project key, license, or OAuth configuration", () => {
    const config = loadConfig(localEnvironment);
    expect(config.runtime.mode).toBe("local");
    expect(config.runtime.durableHistory).toBe(true);
    expect(config.singleUser).toBe(true);
    expect(config.auth).toBeUndefined();
    expect(config.learning).toBeUndefined();
    expect(config.learningAutoAssign).toBe(false);
    expect(config.selfHostBanner).toBe(false);
  });

  test("keeps local history in the selected data directory", () => {
    const config = loadConfig({
      ...localEnvironment,
      FREE_BOT_DATA_DIR: "/tmp/free-bot-fixture",
    });
    expect(config.runtime).toEqual({
      mode: "local",
      durableHistory: true,
      path: "/tmp/free-bot-fixture/conversations.sqlite",
    });
  });

  test("explicit local mode ignores old hosted credentials and learning settings", () => {
    const config = loadConfig({
      ...localEnvironment,
      OPENBOT_RUNTIME: "local",
      INTELLIGENCE_API_KEY: "unused-project-key",
      CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "old-container",
      INTELLIGENCE_SERVICE_TOKEN: "unused-service-token",
    });
    expect(config.runtime.mode).toBe("local");
    expect(config.learning).toBeUndefined();
    expect(config.learningSetup).toBeUndefined();
  });

  test("refuses local mode with an organization authority", () => {
    expect(() =>
      loadConfig({
        ...localEnvironment,
        OPENBOT_ORGANIZATION_AUTH_URL: "https://company.example",
      }),
    ).toThrow("requires single-user access");
  });

  test("refuses to turn off single-user access in local mode", () => {
    expect(() =>
      loadConfig({ ...localEnvironment, OPENBOT_SINGLE_USER: "false" }),
    ).toThrow();
  });

  test("refuses local mode with OAuth configured", () => {
    expect(() =>
      loadConfig({
        ...localEnvironment,
        GOOGLE_OAUTH_CLIENT_ID: "fixture",
        GOOGLE_OAUTH_CLIENT_SECRET: "fixture",
        BETTER_AUTH_SECRET: "fixture-auth-secret-with-at-least-32-characters",
        BETTER_AUTH_URL: "http://localhost:3001",
        INITIAL_ADMIN_EMAILS: "fixture@example.test",
      }),
    ).toThrow("requires single-user access");
  });

  test("refuses non-loopback browser origins", () => {
    expect(() =>
      loadConfig({
        ...localEnvironment,
        TRUSTED_ORIGINS: "http://192.168.1.10:3010",
      }),
    ).toThrow("requires loopback URLs");
  });

  test("rejects unknown runtime modes", () => {
    expect(() =>
      loadConfig({ ...localEnvironment, OPENBOT_RUNTIME: "unknown" }),
    ).toThrow("OPENBOT_RUNTIME must be local or intelligence");
  });

  test("validates the separate optional callback listener port", () => {
    const config = loadConfig({
      ...localEnvironment,
      FREE_BOT_CALLBACK_PORT: "3032",
    });
    expect(config.runtime).toMatchObject({ mode: "local", callbackPort: 3032 });
    for (const port of ["0", "65536", "3031.5", "3001", "invalid"]) {
      expect(() =>
        loadConfig({ ...localEnvironment, FREE_BOT_CALLBACK_PORT: port }),
      ).toThrow("FREE_BOT_CALLBACK_PORT");
    }
  });

  test("still validates explicitly selected Intelligence credentials", () => {
    expect(() =>
      loadConfig({ ...localEnvironment, OPENBOT_RUNTIME: "intelligence" }),
    ).toThrow("CopilotKit Intelligence is required and is not configured");
  });
});
