import { z } from "zod";
import { RepoProfile } from "./manifest.ts";

export const HostCredential = z.object({
  username: z.string().regex(/^[\w.@+-]+$/, "must be [A-Za-z0-9_.@+-]+"),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be a valid env var name"),
});
export type HostCredential = z.infer<typeof HostCredential>;

/** HTTPS credential identity includes a nondefault port; URL.host removes an explicit default 443. */
export const normalizeCredentialHost = (host: string): string => new URL(`https://${host}`).host;

export const HostCredentials = z
  .record(z.string().regex(/^[a-z0-9.-]+(:\d{1,5})?$/i, "must be a host name with an optional port"), HostCredential)
  .transform((credentials, ctx) => {
    const normalized = new Map<string, HostCredential>();
    for (const [host, credential] of Object.entries(credentials)) {
      let key: string;
      try {
        key = normalizeCredentialHost(host);
      } catch {
        ctx.addIssue({ code: "custom", path: [host], message: "must be a valid HTTPS credential host and port" });
        continue;
      }
      if (normalized.has(key)) {
        ctx.addIssue({ code: "custom", path: [host], message: `duplicates normalized HTTPS credential host ${key}` });
      } else {
        normalized.set(key, credential);
      }
    }
    return Object.fromEntries(normalized);
  });
export type HostCredentials = z.infer<typeof HostCredentials>;

export const DEFAULT_CREDENTIALS: HostCredentials = {
  "github.com": { username: "x-access-token", tokenEnv: "GITHUB_TOKEN" },
};

export const BotConfig = z.object({
  name: z.string().min(1),
  repos: RepoProfile.shape.repos,
  gitCredentials: HostCredentials.optional().default(DEFAULT_CREDENTIALS),
  snapshotName: z.string().min(1).default("codebase-researcher-corpus"),
});
export type BotConfig = z.infer<typeof BotConfig>;

/**
 * Validates and returns the BotConfig, applying env overrides.
 * `REPOS=owner/a,owner/b` replaces the repo list (for local dev and testing).
 * `SNAPSHOT_NAME` overrides `snapshotName`.
 */
export function defineConfig(
  raw: z.input<typeof BotConfig>,
  env: NodeJS.ProcessEnv = process.env,
): BotConfig {
  const config = BotConfig.parse(raw);
  const repos = env.REPOS?.trim();
  if (repos) {
    config.repos = BotConfig.shape.repos.parse(
      repos.split(",").map((r) => ({ repository: r.trim() })),
    );
  }
  if (env.SNAPSHOT_NAME) {
    config.snapshotName = env.SNAPSHOT_NAME;
  }
  return config;
}
