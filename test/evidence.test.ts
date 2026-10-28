import { afterAll, describe, expect, it } from "vitest";
import { buildEvidenceUrl, type Evidence, type FinalAnswer } from "../src/investigation.ts";
import type { RepoManifest } from "../src/manifest.ts";
import { filterEvidence } from "../src/tasks.ts";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { validateSubmission } from "../src/runner/submit.ts";
import { makeCitationFixture, makeInput, REPO } from "./helpers.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";
const manifest: RepoManifest = {
  profile: "test",
  created_at: new Date().toISOString(),
  repos: [{ repository: "acme/api", branch: "main", commit: sha, path: "/opt/researcher/repos/acme/api" }],
};

const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  repository: "acme/api",
  commit: sha.slice(0, 7),
  path: "src/main.ts",
  start_line: 10,
  end_line: 24,
  ...overrides,
});

const finalAnswer = (ev: Evidence[]): FinalAnswer => ({
  status: "final_answer",
  answer: "test",
  confidence: "high",
  observed_in_code: ["x"],
  inferred_behavior: [],
  not_established: [],
  evidence: ev,
  suggested_owner: "team",
  escalation_question: "?",
});

const kept = (result: ReturnType<typeof filterEvidence>["result"]) => (result.status === "final_answer" ? result.evidence : []);

describe("filterEvidence", () => {
  it("pins kept evidence to the manifest repository and full commit, replacing any model-supplied url with a GitHub link", () => {
    const { result, dropped } = filterEvidence(finalAnswer([evidence({ repository: "ACME/api", url: "https://evil.example.com" })]), manifest);
    expect(dropped).toEqual([]);
    expect(kept(result)).toEqual([
      { ...evidence(), commit: sha, url: `https://github.com/acme/api/blob/${sha}/src/main.ts#L10-L24` },
    ]);
  });

  it("links with the manifest repository's browse style and clone URL", () => {
    const repos = [{ ...manifest.repos[0]!, browse: "gitlab", url: "https://gitlab.com/acme/platform/api.git" }] as RepoManifest["repos"];
    const { result } = filterEvidence(finalAnswer([evidence()]), { ...manifest, repos });
    expect(kept(result)[0]?.url).toBe(`https://gitlab.com/acme/platform/api/-/blob/${sha}/src/main.ts#L10-L24`);
  });

  it("drops evidence whose repository or commit is not in the manifest", () => {
    const strays = [evidence({ repository: "acme/other" }), evidence({ commit: "deadbeef" })];
    const { result, dropped } = filterEvidence(finalAnswer([evidence(), ...strays]), manifest);
    expect(kept(result)).toHaveLength(1);
    expect(dropped).toEqual(strays);
  });
});

describe("buildEvidenceUrl", () => {
  const e = evidence({ commit: sha });

  it("builds GitHub, GitLab, Bitbucket, and custom-template links", () => {
    expect(buildEvidenceUrl(e)).toBe(`https://github.com/acme/api/blob/${sha}/src/main.ts#L10-L24`);
    expect(buildEvidenceUrl(e, "gitlab", "https://gitlab.com/acme/platform/api.git")).toBe(
      `https://gitlab.com/acme/platform/api/-/blob/${sha}/src/main.ts#L10-L24`,
    );
    expect(buildEvidenceUrl(e, "bitbucket", "https://bitbucket.org/acme/api.git")).toBe(`https://bitbucket.org/acme/api/src/${sha}/src/main.ts#lines-10:24`);
    expect(buildEvidenceUrl(e, "{base}/-/blob/{commit}/{path}?start={start}&end={end}", "https://git.corp.example.com/acme/api.git")).toBe(
      `https://git.corp.example.com/acme/api/-/blob/${sha}/src/main.ts?start=10&end=24`,
    );
    expect(buildEvidenceUrl(e, "gitlab")).toBe(`https://github.com/acme/api/-/blob/${sha}/src/main.ts#L10-L24`);
  });

  it("percent-encodes path segments", () => {
    expect(buildEvidenceUrl({ ...e, path: "./docs/a b|c>.md", start_line: 3, end_line: 3 })).toBe(
      `https://github.com/acme/api/blob/${sha}/docs/a%20b%7Cc%3E.md#L3-L3`,
    );
  });
});

describe("validated citation links", () => {
  const fx = makeCitationFixture();
  const input = makeInput(fx);
  afterAll(() => rm(dirname(fx.reposRoot), { recursive: true, force: true }));

  it("links an accepted symlink citation to its target file", () => {
    const verdict = validateSubmission(finalAnswer([{
      repository: REPO, commit: fx.commit.slice(0, 7), path: "source-alias.ts", start_line: 2, end_line: 3,
    }]), { manifest: input.manifest, repos_root: fx.reposRoot });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error(verdict.problems.join("\n"));
    const { result, dropped } = filterEvidence(verdict.result, input.manifest);
    expect(dropped).toEqual([]);
    expect(kept(result)).toEqual([{
      repository: REPO, commit: fx.commit, path: "src/source.ts", start_line: 2, end_line: 3,
      url: `https://github.com/${REPO}/blob/${fx.commit}/src/source.ts#L2-L3`,
    }]);
  });
});
