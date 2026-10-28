// Used by the workflow's `deliver` subtask (signs) and by TypeScript callback
// receivers (verifies). Note: callback secrets travel in task input, which is
// visible in the Render Dashboard.

import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function signCallback(
  secret: string,
  body: string,
  timestampSeconds?: number,
): { signature: string; timestamp: number } {
  const ts = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return { signature: `v1=${sig}`, timestamp: ts };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * CALLBACK_ALLOWED_ORIGINS as normalized origins; unset or blank disables callbacks. Delivery runs on the
 * workflow host, outside Sandbox egress rules, so only operator-approved origins are reachable.
 */
export function callbackOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CALLBACK_ALLOWED_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const url = URL.parse(entry.trim());
    const localHttp = url?.protocol === "http:" && LOOPBACK.has(url.hostname) && env.RENDER !== "true";
    if (!url || (url.protocol !== "https:" && !localHttp) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`CALLBACK_ALLOWED_ORIGINS: ${JSON.stringify(entry.trim())} must be an https:// origin with no path`);
    }
    return url.origin;
  });
}

export const isApprovedCallback = (url: string, origins: readonly string[]): boolean =>
  origins.includes(URL.parse(url)?.origin ?? "");

const CALLBACK_MAX_SKEW_SECONDS = 5 * 60;

export function verifyCallback(opts: {
  secret: string;
  signature: string | undefined;
  timestamp: string | number | undefined;
  body: string;
  maxAgeSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const { signature, timestamp } = opts;
  if (!signature || timestamp === undefined) return false;
  const ts = typeof timestamp === "number" ? timestamp : Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.maxAgeSeconds ?? CALLBACK_MAX_SKEW_SECONDS)) return false;
  const expected = `v1=${createHmac("sha256", opts.secret).update(`${ts}.${opts.body}`).digest("hex")}`;
  return safeEqual(expected, signature);
}
