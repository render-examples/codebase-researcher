import { describe, expect, it } from "vitest";
import { refreshSnapshot } from "../src/cron.ts";
import { createLog } from "../src/log.ts";

const SNAPSHOT_NAME = "codebase-researcher-corpus";

function capture() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: createLog({}, (l) => void lines.push(JSON.parse(l))) };
}

describe("refreshSnapshot", () => {
  it("logs one info snapshot_refresh line with the built snapshot", async () => {
    const { lines, log } = capture();
    const repos = ["render-oss/cli", "render-oss/sdk", "render-oss/skills"];
    const result = await refreshSnapshot({ snapshotName: SNAPSHOT_NAME, rebuild: async () => ({ id: "snp-1", repos }), commit: "abc1234", log });

    expect(result).toMatchObject({ ok: true, snapshot_id: "snp-1", repos: 3, repositories: repos, commit: "abc1234" });
    expect(lines).toEqual([
      expect.objectContaining({
        level: "info",
        event: "snapshot_refresh",
        ok: true,
        snapshot_id: "snp-1",
        snapshot_name: SNAPSHOT_NAME,
        commit: "abc1234",
        repos: 3,
        repositories: repos,
        duration_ms: expect.any(Number),
      }),
    ]);
  });

  it("logs one error snapshot_refresh line with the error, without throwing, when the rebuild fails", async () => {
    const { lines, log } = capture();
    const rebuild = async (): Promise<never> => {
      throw new Error("clone failed");
    };
    const result = await refreshSnapshot({ snapshotName: SNAPSHOT_NAME, rebuild, log });

    expect(result).toMatchObject({ ok: false });
    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        event: "snapshot_refresh",
        ok: false,
        snapshot_id: null,
        snapshot_name: SNAPSHOT_NAME,
        commit: null,
        repos: 0,
        error: "clone failed",
        duration_ms: expect.any(Number),
      }),
    ]);
  });
});
