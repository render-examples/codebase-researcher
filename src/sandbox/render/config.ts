import { join } from "node:path";
import type { SandboxNetworkPolicy } from "@renderinc/sdk/experimental";
import { z } from "zod";
import config from "../../../config.ts";
import { DEFAULT_CREDENTIALS, type HostCredentials } from "../../bot-config.ts";
import { present } from "../../util.ts";
import { REPO_ROOT } from "../interface.ts";
import { abortable, REQUEST_TIMEOUT_MS } from "./transport.ts";

export type NetworkPolicy = SandboxNetworkPolicy;

export type RenderConfig = {
  apiKey: string;
  workspaceId: `tea-${string}`;
  /** Resolved per-host credentials: host → { username, token }. */
  hostCredentials: Record<string, { username: string; token: string }>;
  networkPolicy: NetworkPolicy;
  investigationTimeoutSeconds: number;
  builderTimeoutSeconds: number;
  /** Client-side pacing for the 100 req/min workspace limit. */
  minRequestIntervalMs: number;
  sandboxDir: string;
};

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

/** Provider-side backstop for a builder whose cron process died before terminating it. */
const BUILDER_TIMEOUT_SECONDS = 3_600;
/** Sandbox API calls share a 100 requests/minute workspace limit. */
const MIN_REQUEST_INTERVAL_MS = 1_000;

export async function loadRenderConfig(
  env: NodeJS.ProcessEnv = process.env,
  derivedAllowedDomain?: string,
  fetcher?: typeof fetch,
): Promise<RenderConfig> {
  const e = z
    .object({
      RENDER_API_KEY: z.string({ error: "RENDER_API_KEY is required for Render sandboxes" }).min(1, "RENDER_API_KEY is required for Render sandboxes"),
      RENDER_WORKSPACE_ID: z.string().regex(/^tea-/, "RENDER_WORKSPACE_ID must be a tea-… workspace id").optional(),
      SANDBOX_NETWORK_POLICY: z.enum(["allow-list", "allow-all", "deny-all"]).default("allow-list"),
      SANDBOX_ALLOWED_DOMAINS: z.string().optional(),
      SANDBOX_TIMEOUT_SECONDS: positiveInt(1_800).pipe(z.number().max(86_400)),
    })
    .parse(present(env));
  const explicit = e.SANDBOX_ALLOWED_DOMAINS
    ? [...new Set(e.SANDBOX_ALLOWED_DOMAINS.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean))]
    : undefined;
  const domains = explicit?.length ? explicit : derivedAllowedDomain ? [derivedAllowedDomain] : [];
  if (e.SANDBOX_NETWORK_POLICY === "allow-list" && !domains.length && e.SANDBOX_ALLOWED_DOMAINS !== undefined) {
    throw new Error("SANDBOX_ALLOWED_DOMAINS must list at least one domain when SANDBOX_NETWORK_POLICY=allow-list");
  }
  const workspaceId = e.RENDER_WORKSPACE_ID
    ? (e.RENDER_WORKSPACE_ID as `tea-${string}`)
    : await resolveWorkspaceId(e.RENDER_API_KEY, fetcher);
  return {
    apiKey: e.RENDER_API_KEY,
    workspaceId,
    hostCredentials: collectHostCredentials(config.gitCredentials, env),
    networkPolicy:
      e.SANDBOX_NETWORK_POLICY === "allow-list"
        ? { type: "allow-list", rules: domains.map((domain) => ({ domain, protocol: "https" })) }
        : { type: e.SANDBOX_NETWORK_POLICY },
    investigationTimeoutSeconds: e.SANDBOX_TIMEOUT_SECONDS,
    builderTimeoutSeconds: BUILDER_TIMEOUT_SECONDS,
    minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
    sandboxDir: join(REPO_ROOT, "sandbox"),
  };
}

function collectHostCredentials(
  creds: HostCredentials | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, { username: string; token: string }> {
  const result: Record<string, { username: string; token: string }> = {};
  for (const [host, { username, tokenEnv }] of Object.entries(creds ?? DEFAULT_CREDENTIALS)) {
    const token = env[tokenEnv]?.trim();
    if (token) result[host] = { username, token };
  }
  return result;
}

type Owner = { id: string; name: string; type: string };

/**
 * Resolves the workspace id from the Render API when `RENDER_WORKSPACE_ID` is not set.
 * Exactly one workspace → uses it; several → fails listing each; none → fails clearly.
 *
 * API: GET /v1/owners — https://api-docs.render.com/reference/list-owners
 */
export async function resolveWorkspaceId(apiKey: string, fetcher: typeof fetch = fetch, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)): Promise<`tea-${string}`> {
  const owners: Owner[] = [];
  for (let cursor: string | undefined; ; ) {
    signal.throwIfAborted();
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await abortable(fetcher(`https://api.render.com/v1/owners?${params}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal,
    }), signal);
    if (!res.ok) throw new Error(`Render API /v1/owners failed: ${res.status}`);
    const page = (await abortable(res.json(), signal)) as { owner: Owner; cursor: string }[];
    owners.push(...page.map((item) => item.owner));
    cursor = page.at(-1)?.cursor;
    if (page.length < 100 || !cursor) break;
  }
  if (owners.length === 0) throw new Error("RENDER_API_KEY has no workspaces; check the key");
  if (owners.length > 1) {
    const list = owners.map((o) => `  ${o.id} (${o.name}, ${o.type})`).join("\n");
    throw new Error(`RENDER_WORKSPACE_ID is required: the API key has access to multiple workspaces:\n${list}`);
  }
  return owners[0]!.id as `tea-${string}`;
}
