import { AsyncLocalStorage } from "node:async_hooks";
import { getUserAgent } from "@renderinc/sdk";
import { SandboxesClient } from "@renderinc/sdk/experimental";
import createClient, { type Client } from "openapi-fetch";
import type { RenderConfig } from "./config.ts";

type ApiClient = ConstructorParameters<typeof SandboxesClient>[0];
type ApiPaths = ApiClient extends Client<infer Paths> ? Paths : never;
const operation = new AsyncLocalStorage<AbortSignal>();
export const REQUEST_TIMEOUT_MS = 30_000;

export function deadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Scopes SDK calls whose public signatures do not accept a control-plane signal. */
export function withSandboxSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return operation.run(signal, fn);
}

/** Retains a late-result observer even after the caller stops waiting. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, onLateResult?: (value: T) => Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = signal.aborted;
    const onAbort = () => { aborted = true; reject(signal.reason); };
    if (aborted) reject(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      if (aborted) {
        if (onLateResult) void Promise.resolve().then(() => onLateResult(value)).catch(() => {});
      }
      else resolve(value);
    }, (err: unknown) => {
      signal.removeEventListener("abort", onAbort);
      if (!aborted) reject(err);
    });
  });
}

export function createSandboxApi(cfg: RenderConfig, requestTimeoutMs: number): SandboxesClient {
  const api = createClient<ApiPaths>({
    // Workflows local-dev variables must never redirect Sandbox credentials to its local server.
    baseUrl: "https://api.render.com/v1",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "User-Agent": getUserAgent() },
    fetch: (request) => {
      const signal = deadline(operation.getStore(), requestTimeoutMs);
      signal.throwIfAborted();
      return fetch(new Request(request, { signal: AbortSignal.any([request.signal, signal]) }));
    },
  });
  return new SandboxesClient(api, cfg.workspaceId, process.env.RENDER_REGION);
}
