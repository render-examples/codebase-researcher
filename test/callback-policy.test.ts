import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/api.ts";
import { assertCallbackAllowed, loadCallbackPolicy } from "../src/callback-policy.ts";
import { loadConfig } from "../src/workflow.ts";

describe("callback destination policy", () => {
  it.each([undefined, "", "  "])("disables callbacks when origins are missing or blank (%s)", (origins) => {
    const policy = loadCallbackPolicy({ CALLBACK_ALLOWED_ORIGINS: origins });
    expect(policy.allowedOrigins).toEqual([]);
    expect(() => assertCallbackAllowed("https://receiver.example/hook", policy)).toThrow(/not approved/);
  });

  it("normalizes and deduplicates origins while approving all paths on the exact origin", () => {
    const policy = loadCallbackPolicy({ CALLBACK_ALLOWED_ORIGINS: "https://RECEIVER.example:443/, https://receiver.example" });
    expect(policy.allowedOrigins).toEqual(["https://receiver.example"]);
    expect(() => assertCallbackAllowed("https://receiver.example/hooks/1?ticket=2", policy)).not.toThrow();
    for (const url of [
      "https://receiver.example:8443/hook",
      "https://sub.receiver.example/hook",
      "https://receiver.example.attacker.example/hook",
      "https://user:password@receiver.example/hook",
      "http://receiver.example/hook",
      "https://10.0.0.1/hook",
      "https://[::1]/hook",
    ]) expect(() => assertCallbackAllowed(url, policy), url).toThrow();
  });

  it.each([
    "not a URL",
    "https:receiver.example",
    "https://receiver.example/hook",
    "https://receiver.example/hooks/..",
    "https://receiver.example/./",
    "https://receiver.example/%2e",
    "https://receiver.example?ticket=1",
    "https://receiver.example?",
    "https://receiver.example#section",
    "https://receiver.example#",
    "https://receiver.example\\",
    "https://user:password@receiver.example",
    "ftp://receiver.example",
    "http://receiver.example",
    "http://localhost:4000",
    "https://receiver.example,",
  ])("rejects malformed, non-origin, or unsupported configuration: %s", (origin) => {
    expect(() => loadCallbackPolicy({ CALLBACK_ALLOWED_ORIGINS: origin })).toThrow(/CALLBACK_ALLOWED_ORIGINS/);
  });

  it.each(["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000"])(
    "requires both local development and explicit approval for %s", (origin) => {
      const policy = loadCallbackPolicy({ CALLBACK_ALLOWED_ORIGINS: origin, RENDER_LOCAL_DEV_URL: "http://localhost:8121" });
      expect(policy.isLocalDev).toBe(true);
      expect(() => assertCallbackAllowed(`${origin}/hook`, policy)).not.toThrow();
      expect(() => assertCallbackAllowed(`${origin}/hook`, loadCallbackPolicy({ RENDER_USE_LOCAL_DEV: "true" }))).toThrow(/not approved/);
      expect(() => loadCallbackPolicy({ CALLBACK_ALLOWED_ORIGINS: origin, RENDER: "true", RENDER_USE_LOCAL_DEV: "true" })).toThrow();
    },
  );

  it.each(["http://remote.example:8121", "invalid", "https://localhost:8121"])(
    "does not enable loopback HTTP from an unverified local-dev URL: %s", (localDevUrl) => {
      expect(() => loadCallbackPolicy({ CALLBACK_ALLOWED_ORIGINS: "http://localhost:4000", RENDER_LOCAL_DEV_URL: localDevUrl })).toThrow();
    },
  );

  it("loads the same policy and validates bad settings at both service configuration boundaries", () => {
    const env = { API_TOKEN: "test-token", QUESTION_ID_SECRET: "q".repeat(32), RENDER_API_KEY: "synthetic", CALLBACK_ALLOWED_ORIGINS: "https://receiver.example:8443" };
    expect(loadEnv(env).callbackPolicy).toEqual(loadConfig(env).callbackPolicy);
    expect(loadEnv({ ...env, CALLBACK_ALLOWED_ORIGINS: " " }).callbackPolicy.allowedOrigins).toEqual([]);
    expect(loadConfig({ CALLBACK_ALLOWED_ORIGINS: " " }).callbackPolicy.allowedOrigins).toEqual([]);
    expect(() => loadEnv({ ...env, CALLBACK_ALLOWED_ORIGINS: "https://receiver.example/path" })).toThrow();
    expect(() => loadConfig({ CALLBACK_ALLOWED_ORIGINS: "https://receiver.example/path" })).toThrow();
  });
});
