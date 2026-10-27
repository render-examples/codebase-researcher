import { z } from "zod";

export type CallbackPolicy = {
  allowedOrigins: readonly string[];
  isLocalDev: boolean;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_DEV_VALUES = new Set(["1", "t", "T", "true", "TRUE", "True"]);

function isLocalDev(env: NodeJS.ProcessEnv): boolean {
  if (env.RENDER === "true") return false;
  if (LOCAL_DEV_VALUES.has(env.RENDER_USE_LOCAL_DEV ?? "")) return true;
  if (!env.RENDER_LOCAL_DEV_URL) return false;
  try {
    const url = new URL(env.RENDER_LOCAL_DEV_URL);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function destination(raw: string, localDev: boolean): URL {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("callback URLs must not contain credentials");
  if (url.protocol !== "https:" && !(localDev && url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("callbacks require HTTPS; explicit loopback HTTP origins are allowed only in local development");
  }
  return url;
}

const PolicyEnv = z.object({ CALLBACK_ALLOWED_ORIGINS: z.string().optional() }).transform((env, ctx) => {
  if (!env.CALLBACK_ALLOWED_ORIGINS) return [];
  const entries = env.CALLBACK_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim());
  if (entries.some((origin) => !origin)) {
    ctx.addIssue({ code: "custom", path: ["CALLBACK_ALLOWED_ORIGINS"], message: "must be a comma-separated list of origins without empty entries" });
    return z.NEVER;
  }
  return entries;
});

/** Missing or blank configuration disables callbacks. The environment is operator-controlled. */
export function loadCallbackPolicy(env: NodeJS.ProcessEnv = process.env): CallbackPolicy {
  const localDev = isLocalDev(env);
  const entries = PolicyEnv.parse({ CALLBACK_ALLOWED_ORIGINS: env.CALLBACK_ALLOWED_ORIGINS?.trim() || undefined });
  const origins = entries.map((raw) => {
    try {
      const url = destination(raw, localDev);
      if (!/^https?:\/\/[^\s/?#\\]+\/?$/i.test(raw) || url.pathname !== "/") {
        throw new Error("entries must be origins only, without paths, query strings, or fragments");
      }
      return url.origin;
    } catch {
      throw new Error("CALLBACK_ALLOWED_ORIGINS must contain valid HTTPS origins only (loopback HTTP requires local development)");
    }
  });
  return { allowedOrigins: [...new Set(origins)], isLocalDev: localDev };
}

/** All paths on an approved origin are trusted; redirects must still be rejected by the sender. */
export function assertCallbackAllowed(raw: string, policy: CallbackPolicy): void {
  const url = destination(raw, policy.isLocalDev);
  if (!policy.allowedOrigins.includes(url.origin)) {
    throw new Error("callback origin is not approved by CALLBACK_ALLOWED_ORIGINS; omit callback to use polling");
  }
}
