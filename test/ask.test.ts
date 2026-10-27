import { execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { createApp, type TaskRun } from "../src/api.ts";
import { createLog } from "../src/log.ts";

const API_TOKEN = "synthetic-cli-api-token";
const RUN_ID = "run-cli-safe-failure";
const MARKER = "SYNTHETIC_TASK_DIAGNOSTIC_NOT_FOR_CALLERS";

function ask(apiUrl: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/ask.ts", import.meta.url)), "What failed?"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { PATH: process.env.PATH, API_URL: apiUrl, API_TOKEN },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : error ? null : 0, stdout, stderr }));
  });
}

async function askWithRun(run: TaskRun) {
  const lookups: string[] = [];
  // Keep this structural fixture compatible with the separate question-ID signing secret.
  const deps = {
    apiToken: API_TOKEN,
    questionIdSecret: "synthetic-question-id-secret".repeat(2),
    startQuestion: async () => ({ id: RUN_ID }),
    getTaskRun: async (id: string) => {
      lookups.push(id);
      return run;
    },
    isLocalDev: true,
    log: createLog({}, () => {}),
  };
  const server = serve({ fetch: createApp(deps).fetch, hostname: "127.0.0.1", port: 0 });
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
    return { ...await ask(`http://127.0.0.1:${address.port}`), lookups };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("ask CLI workflow failures", { timeout: 10_000 }, () => {
  it.each(["failed", "canceled"])("shows a safe %s response and correlation from the real API", async (status) => {
    const result = await askWithRun({ status, results: [], error: MARKER });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(MARKER);
    expect(result.stderr).toContain("The investigation could not be completed.");
    expect(result.stderr).toContain(`Trace ${RUN_ID}.`);
    expect(result.lookups).toEqual([RUN_ID]);
  });

  it("preserves the safe failure reply of a successfully completed workflow", async () => {
    const reply = { kind: "failure", traceId: "completed-investigation-trace", reason: "the investigation hit its time limit" };
    const result = await askWithRun({ status: "succeeded", results: [{ trace_id: reply.traceId, reply }], error: MARKER });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(MARKER);
    expect(result.stdout).toContain(`I couldn't complete this investigation: ${reply.reason}. Trace ${reply.traceId}.`);
    expect(result.lookups).toEqual([RUN_ID]);
  });
});
