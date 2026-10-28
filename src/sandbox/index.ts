import type { Log } from "../log.ts";
import type { OpenSandbox } from "./interface.ts";
import { localSandboxes, loadLocalConfig } from "./local.ts";
import { SandboxClient } from "./render/client.ts";
import { loadRenderConfig } from "./render/config.ts";
import { openRenderSandbox } from "./render/sandbox.ts";

export { SandboxMisconfiguredError, SnapshotUnavailableError, type OpenSandbox, type RunInvestigationResult, type Sandbox } from "./interface.ts";

/**
 * Loads sandbox config and returns a way to open investigation sandboxes. Selects by `SANDBOX_PROVIDER`
 * (`render` | `local`); defaults to `render` on Render (which sets `RENDER=true`), else `local`.
 * Throws on bad config, so callers can tell misconfiguration apart from a failed sandbox.
 */
export async function configureSandboxes(
  env: NodeJS.ProcessEnv,
  log: Log,
  allowedDomain?: string,
  fetcher?: typeof fetch,
): Promise<OpenSandbox> {
  const kind = env.SANDBOX_PROVIDER || (env.RENDER === "true" ? "render" : "local");
  switch (kind) {
    case "local":
      return localSandboxes(loadLocalConfig(env));
    case "render": {
      const client = SandboxClient.fromConfig(await loadRenderConfig(env, allowedDomain, fetcher), log);
      return (snapshotName, opts) => openRenderSandbox(client, snapshotName, opts);
    }
    default:
      throw new Error(`SANDBOX_PROVIDER must be "render" or "local", got ${JSON.stringify(kind)}`);
  }
}
