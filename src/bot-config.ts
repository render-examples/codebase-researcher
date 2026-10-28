import { z } from "zod";
import { RepoProfile } from "./manifest.ts";

export const HostCredential = z.object({
  username: z.string().regex(/^[\w.@+-]+$/, "must be [A-Za-z0-9_.@+-]+"),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be a valid env var name"),
});
export type HostCredential = z.infer<typeof HostCredential>;

export const HostCredentials = z.record(z.string().regex(/^[a-z0-9.-]+(:\d{1,5})?$/, "must be a host name"), HostCredential);
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
