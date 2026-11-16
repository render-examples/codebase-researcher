import { createHash, createHmac } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { safeEqual } from "./callback.ts";

export type WebConfig = {
  password: string;
  sessionSecret: string;
  distDir: string;
};

const SESSION_COOKIE = "researcher_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const TOKEN = /^v1\.(\d{1,15})\.(\d{1,15})\.([\w-]{43})$/;
const Login = z.object({ password: z.string().min(1).max(256) });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Hash first so different password lengths still take the constant-time comparison path. */
export const passwordMatches = (presented: string, expected: string) =>
  safeEqual(sha256(presented), sha256(expected));

/** Changing either web secret invalidates every browser session. */
export const sessionKey = (config: Pick<WebConfig, "password" | "sessionSecret">): Buffer =>
  createHmac("sha256", config.sessionSecret).update(`researcher-session:${config.password}`).digest();

const sign = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("base64url");

export function issueSession(key: Buffer, nowMs = Date.now()): string {
  const body = `v1.${nowMs}.${nowMs + SESSION_TTL_MS}`;
  return `${body}.${sign(key, body)}`;
}

export function verifySession(key: Buffer, token: string | undefined, nowMs = Date.now()): boolean {
  const match = token ? TOKEN.exec(token) : null;
  if (!match) return false;
  const [, issuedAt = "", expiresAt = "", signature = ""] = match;
  if (!safeEqual(sign(key, `v1.${issuedAt}.${expiresAt}`), signature)) return false;
  return (
    Number(issuedAt) <= nowMs + CLOCK_SKEW_MS &&
    nowMs < Number(expiresAt) &&
    Number(expiresAt) - Number(issuedAt) <= SESSION_TTL_MS
  );
}

const isHttps = (c: Context) =>
  (c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ??
    new URL(c.req.url).protocol.slice(0, -1)) === "https";

const cookieOptions = (c: Context) => ({
  httpOnly: true,
  sameSite: "Lax" as const,
  path: "/",
  secure: isHttps(c),
});

class LoginThrottle {
  readonly #failures = new Map<string, number[]>();

  retryAfterMs(key: string, nowMs = Date.now()): number {
    const recent = this.#recent(key, nowMs);
    return recent.length >= 10 ? recent[0]! + 60_000 - nowMs : 0;
  }

  fail(key: string, nowMs = Date.now()): void {
    if (this.#failures.size >= 10_000 && !this.#failures.has(key)) {
      for (const existing of this.#failures.keys()) {
        if (!this.#recent(existing, nowMs).length) this.#failures.delete(existing);
      }
      if (this.#failures.size >= 10_000) {
        const oldest = this.#failures.keys().next().value;
        if (oldest) this.#failures.delete(oldest);
      }
    }
    this.#failures.set(key, [...this.#recent(key, nowMs), nowMs]);
  }

  reset(key: string): void {
    this.#failures.delete(key);
  }

  #recent(key: string, nowMs: number): number[] {
    return (this.#failures.get(key) ?? []).filter((time) => nowMs - time < 60_000);
  }
}

const clientKey = (c: Context) =>
  c.req.header("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean).at(-1) ??
  "unknown";

const apiError = (c: Context, status: 400 | 401 | 415 | 429, error: string, message: string) =>
  c.json({ error, message }, status);

/**
 * Stateless browser authentication for the optional UI. The bearer-token API remains separate and
 * unchanged; browser code never receives API_TOKEN.
 */
export function createWebSession(config: WebConfig) {
  const key = sessionKey(config);
  const throttle = new LoginThrottle();

  return {
    status: (c: Context) =>
      c.json({ authenticated: verifySession(key, getCookie(c, SESSION_COOKIE)) }),

    login: async (c: Context) => {
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        return apiError(c, 415, "unsupported_media_type", "Send JSON with Content-Type: application/json");
      }
      const client = clientKey(c);
      const retryAfterMs = throttle.retryAfterMs(client);
      if (retryAfterMs > 0) {
        c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
        return apiError(c, 429, "too_many_attempts", "Too many attempts; try again in a minute");
      }
      const body = Login.safeParse(await c.req.json().catch(() => null));
      if (!body.success || !passwordMatches(body.data.password, config.password)) {
        throttle.fail(client);
        return apiError(c, 401, "wrong_password", "Wrong password");
      }
      throttle.reset(client);
      setCookie(c, SESSION_COOKIE, issueSession(key), {
        ...cookieOptions(c),
        maxAge: SESSION_TTL_MS / 1000,
      });
      return c.body(null, 204);
    },

    logout: (c: Context) => {
      deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
      return c.body(null, 204);
    },

    require: (async (c, next) => {
      if (!verifySession(key, getCookie(c, SESSION_COOKIE))) {
        return apiError(c, 401, "unauthorized", "Sign in first");
      }
      await next();
    }) satisfies MiddlewareHandler,
  };
}
