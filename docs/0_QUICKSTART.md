# Quickstart

Deploy the researcher, ask a question, follow up, and run it locally. Once
the default path works, use [1_EXTENSION.md](1_EXTENSION.md) to point it at
your code, change the agent, or integrate the API into another tool. For the implementation,
continue to [2_ARCHITECTURE.md](2_ARCHITECTURE.md).

## Prerequisites

- A Render workspace with Sandboxes access in **Oregon**.
- A **Render API key** for that workspace.
- A paid Standard instance for the snapshot cron, already selected in
  `render.yaml`. The API runs on the free instance type.
- A dedicated, spend-capped **model API key**. Anthropic is the default; see
  [Choose a model](1_EXTENSION.md#choose-a-model).
- For private repositories, a read-only token for their Git host.
- Node (the version in `.node-version`) and pnpm 11 on your machine, to run
  `pnpm ask`.

## Deploy to Render

The Deploy to Render button in the [README](../README.md) deploys the public
example corpus as is. To investigate your own code, fork this repository
first.

### Configure the fork

Edit and commit:

- [`config.ts`](../config.ts): set the instance name, repositories, Git
  credentials, and snapshot name.
- [`prompt.md`](../prompt.md): describe the product, likely askers, repository
  responsibilities, and source-of-truth rules.

The extension guide covers the complete
[repository configuration](1_EXTENSION.md#configure-the-repository-corpus)
and [prompt](1_EXTENSION.md#customize-the-agent).

### Create the Blueprint

Create a Blueprint from the fork in the Render Dashboard. [`render.yaml`](../render.yaml)
creates one project with three services:

- `codebase-researcher-api`: the HTTP API.
- `codebase-researcher-workflow`: the durable question workflow.
- `codebase-researcher-snapshots`: the hourly snapshot refresh cron.

### Set secrets

The Blueprint prompts for these values. Check them after creation because a
blank `sync: false` value counts as unset.

| Service | Variable | Required when |
|---|---|---|
| API | `RENDER_API_KEY` | Always |
| Workflow | `RENDER_API_KEY` | Always |
| Workflow | `RENDER_WORKSPACE_ID` | The key can access multiple workspaces |
| Workflow | `ANTHROPIC_API_KEY` | Using the default model |
| Snapshot cron | `RENDER_API_KEY` | Always |
| Snapshot cron | `RENDER_WORKSPACE_ID` | The key can access multiple workspaces |
| Snapshot cron | `GITHUB_TOKEN` | Reading private GitHub repositories |

The Blueprint generates separate `API_TOKEN` and `QUESTION_ID_SECRET` values
on the API service and wires `WORKFLOW_SLUG` from the workflow service into
the API. Share only `API_TOKEN` with callers. Keep `QUESTION_ID_SECRET` stable
across API replicas and restarts; it signs polling and follow-up IDs. Existing
deployments must set this new secret before upgrading. IDs issued by older
versions become invalid; start new questions after upgrading. See
[rotation and migration](1_EXTENSION.md#question-id-signing-and-rotation).

Callbacks are optional and disabled by default. To enable them, set the same
`CALLBACK_ALLOWED_ORIGINS` on both the API and workflow, for example
`https://support-hooks.example.com`. Use comma-separated HTTPS origins with
no path, query, fragment, or credentials. Every path on an approved origin is
trusted; choose a dedicated integration origin. Delivery rejects redirects.
Polling needs no callback configuration.

Before upgrading an existing deployment that uses callbacks, configure these
origins on both services. Unapproved new requests and queued deliveries fail
closed after the upgrade; callers can retrieve replies by polling.

### Build the first snapshot

Open `codebase-researcher-snapshots` and click **Trigger Run**, or wait for its
hourly schedule. The first build takes about five minutes. A successful run
logs one `snapshot_refresh` event with `"ok": true`.

Questions cannot run until an available snapshot exists. A build in progress
produces a "snapshot isn't ready" reply; no completed build produces a "no
repository snapshot is available" reply.

## Ask your first question

Copy `API_TOKEN` from the API service and use its public URL:

```bash
export API_TOKEN=...
export API_URL=https://codebase-researcher-api.onrender.com

pnpm install
pnpm ask "How does the CLI pick a workspace in CI?"
```

`pnpm ask` posts the question, polls until the investigation finishes, and
prints the answer with its evidence links. An investigation usually takes one
to two minutes; a free API instance that has spun down adds a cold start to
the first request. Add `--json` to print the raw reply.

The same request with curl returns `202` with a signed question ID:

```bash
curl -X POST "$API_URL/v1/questions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"How does the CLI pick a workspace in CI?"}'
```

```json
{"id":"trn-abc123def456.Kx9mZ7..."}
```

Poll with that ID:

```bash
curl "$API_URL/v1/questions/trn-abc123def456.Kx9mZ7..." \
  -H "Authorization: Bearer $API_TOKEN"
```

While the workflow is active, the status is `running`. A completed workflow
returns `status: "completed"`, with `reply.kind` set to:

- `answer`: a structured answer with commit-pinned, validated evidence.
- `clarification`: a focused question to answer before the agent continues.
- `failure`: a user-safe explanation without internal errors or secrets.

If the parent workflow fails or is canceled, polling returns HTTP `200` with
`status: "failed"`, the generic error `The investigation could not be completed.`,
and a `trace_id` identifying the workflow run. The CLI displays that safe
message and trace ID and exits with status `1`. Give the trace ID to an
operator to find the raw diagnostic in the Render Dashboard.

The full request, polling, callback, and idempotency contracts are in
[Extend the question API](1_EXTENSION.md#extend-the-question-api).

### Follow up

To answer a clarification or ask a related question, pass the earlier
question's ID:

```bash
pnpm ask --follow-up trn-abc123def456.Kx9mZ7... "The GitHub Actions runner"
```

Over HTTP, send `"follow_up_to": "<id>"` with the new `question`. The API
reads the earlier run's conversation and reply and starts a new investigation
with the whole exchange, so the agent sees what it already asked or answered.

## Run it locally

Local development uses the real workflow, runner, tools, and citation checks,
but replaces Render Sandboxes with a child process over local checkouts. It
provides **no isolation**; do not treat it as a security boundary.

Use the Node version in `.node-version`, pnpm 11, and Render CLI 2.11 or later:

```bash
pnpm install
```

### Clone local checkouts

Local repositories live under `.scratch/repos/<owner>/<name>`:

```bash
mkdir -p .scratch/repos/render-oss
for r in cli sdk; do
  git clone "https://github.com/render-oss/$r" ".scratch/repos/render-oss/$r"
done
```

Each configured checkout must exist and have no uncommitted, untracked, or
ignored files. The clean `HEAD` becomes the commit recorded in evidence.

### Start the workflow and API

Run each command in its own terminal:

```bash
# Terminal 1
REPOS=render-oss/cli,render-oss/sdk LOCAL_RUNNER_ARGS=--faux \
  render workflows dev --port 8121 -- pnpm start:workflow

# Terminal 2: these credential values are for local development only.
API_TOKEN=dev-token QUESTION_ID_SECRET=local-only-question-id-secret-1234567890 \
  RENDER_LOCAL_DEV_URL=http://localhost:8121 pnpm start:api
```

Off Render, the workflow uses the local Sandbox provider by default. Callbacks
remain disabled unless both processes receive the same explicit setting, for
example `CALLBACK_ALLOWED_ORIGINS=http://localhost:4000`. Loopback HTTP is
allowed only in local Workflows dev mode: the CLI sets `RENDER_USE_LOCAL_DEV`
for the workflow, and the API verifies its loopback `RENDER_LOCAL_DEV_URL`.
`localhost`, `127.0.0.1`, and `[::1]` are supported; ports must match exactly.
HTTP callbacks are never enabled when running on Render.

Then ask:

```bash
# Terminal 3
export API_TOKEN=dev-token
pnpm ask "What changed in the latest commit?"
pnpm ask "Please clarify how retries work"
pnpm ask --follow-up <id from the clarification> "Web services in Oregon"
```

`LOCAL_RUNNER_ARGS=--faux` follows a deterministic script through the real
tools and citation validator without calling a model. A question containing
"clarify" gets a clarification, so you can exercise the follow-up path. Remove
`--faux` and set the selected provider's API key to run a real investigation.

The local provider rebuilds `.scratch/runner/runner.mjs` for each
investigation, so runner and prompt edits apply to the next question.

### Test

```bash
pnpm typecheck
pnpm test
```

Set `LIVE_MODEL_PROVIDER` and that provider's key to include the live model
smoke test. `LIVE_MODEL` overrides its default model.

## Operate it

### Log events

All services emit one JSON object per line. The most useful events are:

| Event | Service | Meaning |
|---|---|---|
| `task_started` | API | A workflow run started |
| `turn_finished` | Workflow | Final outcome, model, prompt version, commits, usage, cost, and duration |
| `investigation_failed` | Workflow | The agent ran but did not submit an accepted result |
| `workflow_misconfigured` | Workflow | Model or Sandbox configuration is invalid |
| `deliver_failed` | Workflow | Callback retries were exhausted |
| `snapshot_refresh` | Cron | Snapshot build result, repository count, and duration |

Every reply and workflow-level failure response includes a trace ID. Use it
to find the task run in the Dashboard. Alert on consecutive `snapshot_refresh`
events with `"ok": false`; a failed refresh leaves the previous snapshot available.

### After a change

- Changes to repositories, `prompt.md`, `src/runner/`, or
  `sandbox/` require a successful snapshot refresh.
- Changing `snapshotName` requires an immediate refresh; questions fail until
  the new name exists.
- Environment changes take effect when that service redeploys. Trigger the
  cron manually to use new cron variables immediately.

### Troubleshooting

- **Workflow run failed or was canceled:** use the polling response's
  `trace_id` (shown by the CLI as `Trace ...`) to open that run in the Render
  Dashboard. Public responses omit the underlying task diagnostic.
- **No snapshot / snapshot not ready:** trigger the snapshot cron and inspect
  its `snapshot_refresh` event. Common causes are missing Git credentials,
  the wrong workspace ID, or a failed `verify.sh` check.
- **Investigation service is misconfigured:** inspect
  `workflow_misconfigured`. Verify `MODEL_PROVIDER`, `MODEL`,
  `RENDER_API_KEY`, and `RENDER_WORKSPACE_ID`.
- **Agent stopped without submitting:** inspect `investigation_failed`.
  Authentication failures usually mean the model key is missing or invalid.
- **Infrastructure retries exhausted:** inspect failed `investigate` task
  runs. Restore timeouts, Sandbox verification, or a rejected network policy
  are common causes.
- **Callback never arrives:** inspect `deliver_failed` and the `deliver`
  subtask's attempts. The receiver must return 2xx within 10 seconds.
- **First request is slow:** the free API instance spun down after 15 idle
  minutes. Switch it to Starter in `render.yaml` to keep it warm.

### Operating limits

- Sandbox API calls share the workspace's 100-requests-per-minute limit. Each
  investigation makes roughly 15–20 calls, so expect a handful of concurrent
  questions, not dozens.
- A Sandbox has 2 CPUs, 4 GB RAM, and 10 GB storage; the runner, tools, and
  repositories must fit.
- Workflow runs are retained for 30 days. Their inputs include transcripts
  and callback secrets.
- The hourly cron keeps the named snapshot fresh and prevents expiry.
- Default maximums are five minutes to provision a Sandbox and 15 minutes for
  the agent. Render also applies task and Sandbox-level backstops.

See [3_TAKEAWAYS.md](3_TAKEAWAYS.md) for the operational and security
patterns worth carrying into other agent systems.
