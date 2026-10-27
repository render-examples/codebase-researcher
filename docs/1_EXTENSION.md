# Extend the researcher

Start with a working deployment from [0_QUICKSTART.md](0_QUICKSTART.md).
This guide covers the supported extension points: the repository corpus,
agent behavior, model, and the question API that other tools integrate with. Read
[2_ARCHITECTURE.md](2_ARCHITECTURE.md) before changing the host/runner or
Sandbox boundaries.

## Configure the repository corpus

[`config.ts`](../config.ts) is validated at import time by `defineConfig`:

```typescript
export default defineConfig({
  name: "Codebase Researcher",
  repos: [
    { repository: "myorg/api" },
    { repository: "myorg/web", branch: "release" },
  ],
  gitCredentials: {
    "github.com": {
      username: "x-access-token",
      tokenEnv: "GITHUB_TOKEN",
    },
  },
  snapshotName: "my-researcher-corpus",
});
```

- `name` identifies the instance in the snapshot manifest the agent reads.
- `repos` lists `owner/name` repositories. The default branch is resolved at
  snapshot time unless `branch` is set.
- `gitCredentials` maps each Git host to a username and the environment
  variable containing its token. An unset token means clone anonymously.
- `snapshotName` is the stable name built by the cron and restored by the
  workflow. It must match `[A-Za-z0-9_.-]+` and be unique in the workspace.

`REPOS=owner/a,owner/b` and `SNAPSHOT_NAME=...` override the corresponding
values for local development and tests.

Repository, runner, prompt, and `sandbox/` changes become available
only after the snapshot cron builds a new snapshot. All checkouts and runtime
artifacts must fit within the Sandbox's 10 GB.

### Private repositories

Use a fine-grained, read-only token and add its variable only to the snapshot
cron. The workflow that runs the agent does not need Git credentials.

For GitHub, the default `GITHUB_TOKEN` mapping is sufficient. A fork of a
public repository cannot be made private, so create a new private repository
when the researcher itself must remain private.

### Other Git hosts

Set an HTTPS clone `url`, an evidence-link `browse` style, and credentials for
each host:

```typescript
export default defineConfig({
  name: "My Researcher",
  repos: [
    {
      repository: "myorg/infra",
      url: "https://gitlab.com/myorg/infra.git",
      browse: "gitlab",
    },
    {
      repository: "myorg/ops",
      url: "https://bitbucket.org/myorg/ops.git",
      browse: "bitbucket",
    },
  ],
  gitCredentials: {
    "gitlab.com": { username: "oauth2", tokenEnv: "GITLAB_TOKEN" },
    "bitbucket.org": {
      username: "x-token-auth",
      tokenEnv: "BITBUCKET_TOKEN",
    },
  },
  snapshotName: "my-researcher-corpus",
});
```

Declare each token on the cron service in `render.yaml` with `sync: false`.
Only HTTPS clone URLs are accepted.

`browse` may be `github`, `gitlab`, `bitbucket`, or a template containing
`{base}`, `{repository}`, `{commit}`, `{path}`, `{start}`, and `{end}`.
Trusted host code builds links from validated citations; the model never
supplies a delivered evidence URL.

## Customize the agent

### Describe the product

[`prompt.md`](../prompt.md) is the instance-specific part of the system
prompt. Include:

- what the product does and who asks questions;
- which repository owns each subsystem;
- which sources take precedence when code, tests, and docs disagree;
- team names and ownership hints for `suggested_owner`;
- product vocabulary the agent should interpret consistently.

The core investigation method and result format live in
[`src/runner/core-prompt.md`](../src/runner/core-prompt.md). The instance
prompt must remain under 20 KB.

Both prompts are bundled into the runner and baked into the snapshot. Trigger
the snapshot cron after changing either. Each `turn_finished` event includes
`prompt_version`, a hash of the combined prompt.

### Change tools or behavior

The agent runs entirely inside the Sandbox:

- [`src/runner/session.ts`](../src/runner/session.ts) constructs the prompt and
  controls turns, retries, reminders, and time limits.
- [`src/runner/tools.ts`](../src/runner/tools.ts) exposes `read`, `ls`, and a
  guarded `bash`.
- [`src/runner/submit.ts`](../src/runner/submit.ts) validates the structured
  answer and every citation.
- [`src/investigation.ts`](../src/investigation.ts) defines the result schema.
- [`src/runner/protocol.ts`](../src/runner/protocol.ts) is the typed boundary
  between the host and bundled runner.

When adding a tool, decide separately:

1. Is it useful for the model?
2. What is the real security boundary if the model bypasses its input policy?
3. Which credentials or environment values can its subprocess observe?
4. How is its output bounded, logged, and validated?
5. Does it require broader egress or writable storage?

Do not rely on command parsing as the security boundary. The current command
filter is only a usability guard; filesystem permissions and Sandbox network
policy enforce the restrictions.

After runner changes, run `pnpm typecheck`, `pnpm test`, and the snapshot cron.
Use `LOCAL_RUNNER_ARGS=--faux` to exercise the full local path without a model.

## Choose a model

Set `MODEL_PROVIDER` and `MODEL` on the workflow service. Values declared in
`render.yaml` replace Dashboard edits when the Blueprint syncs, so commit the
desired defaults there.

| Provider | Example model | Key variable | Default egress host |
|---|---|---|---|
| `anthropic` | `claude-opus-5` | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `openai` | Set explicitly | `OPENAI_API_KEY` | `api.openai.com` |
| `google` | Set explicitly | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` |

The provider and model must exist in Pi's built-in model registry. Anthropic,
OpenAI, and Google are tested; other registered providers may work but are
not validated end to end.

For a non-Anthropic provider, add its key variable to the workflow service as
`sync: false`; [`src/runner/providers.ts`](../src/runner/providers.ts) lists
the variable for each provider. `THINKING_LEVEL` accepts `off`, `minimal`,
`low`, `medium`, or `high`.

The investigation Sandbox's allow-list is derived from the selected model's
base URL. `SANDBOX_ALLOWED_DOMAINS` overrides it with a comma-separated list
of HTTPS hosts. Matching is exact; use a leftmost wildcard when subdomains are
required. Because this replaces the derived default, retain the model host:
`api.anthropic.com,api.github.com,*.pypi.org`. Use a dedicated, spend-capped
key; DNS remains a documented residual risk.

## Extend the question API

Every `/v1/*` request uses `Authorization: Bearer <API_TOKEN>`.
`GET /healthz` is unauthenticated. [`src/ask.ts`](../src/ask.ts) is a
complete client in about 100 lines: post, poll, and render each reply kind.

### Start a question

```bash
curl -X POST "$API_URL/v1/questions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ticket-4821" \
  -d '{
    "question":"Where is workspace selection validated?",
    "metadata":{"ticket":4821}
  }'
```

The request body accepts:

- `question`: the question, at most 8,000 characters.
- `follow_up_to`: optional ID of an earlier question to continue. The API
  rebuilds the conversation from that run: its messages, then its reply as
  the agent's turn, then the new question. The earlier run must have
  finished (`409` otherwise), and a conversation holds at most 200 messages.
- `callback`: optional `{ "url": "https://...", "secret": "..." }`. Secrets
  must be 16–256 characters. The URL must use an origin explicitly approved
  by the operator in `CALLBACK_ALLOWED_ORIGINS`; callbacks are disabled when
  that setting is missing or blank.
- `metadata`: optional routing data with at most 16 string, number, or boolean
  values. It is returned unchanged in the callback.

Use a stable `Idempotency-Key` when callers may retry. The API passes it to
Render Workflows, preventing a duplicate run.

### Poll and handle replies

`POST` returns `202 {"id":"<signed question id>"}`. Poll:

```bash
curl "$API_URL/v1/questions/<id>" \
  -H "Authorization: Bearer $API_TOKEN"
```

Pending and active runs return `{"status":"running"}`. A completed run
contains one of:

```typescript
type Reply =
  | {
      kind: "answer";
      traceId: string;
      result: FinalAnswer;
      model?: string;
      manifestCreatedAt?: string;
    }
  | {
      kind: "clarification";
      traceId: string;
      result: NeedsClarification;
    }
  | {
      kind: "failure";
      traceId: string;
      reason: string;
    };
```

For a clarification, show `result.question` to the asker and send their
answer as a new question with `follow_up_to` set to this ID. Failure reasons
are safe to display. A workflow-level `failed` status means the parent task
itself failed or was canceled.

Question IDs are `<task run ID>.<MAC>`, signed with `API_TOKEN`. Rotating the
token invalidates outstanding IDs. The signature also prevents this API from
reading unrelated workflow runs in the workspace.

### Receive callbacks

Polling suits scripts and short-lived callers. A long-lived integration, such
as a chat bot or support desk, can use a callback after the operator enables it.
Set the same `CALLBACK_ALLOWED_ORIGINS` on the API and workflow, for example
`https://support-hooks.example.com,https://events.example.com:8443`. The API
checks before starting work, and the delivery subtask checks independently.
Missing or blank configuration disables callbacks and leaves polling available.
Malformed configuration prevents the service from starting its work.

Each entry must be an origin only: scheme, host, and optional port, with no
credentials, path, query, or fragment. Matching uses normalized `URL.origin`;
subdomains and different ports need their own entries. Approved origins are
operator-trusted, including every path they serve. Choose a dedicated
integration origin and review its outbound behavior. All HTTP redirects are
rejected, even to another approved origin, so receivers must accept the POST
directly.

Production accepts HTTPS only. Local development additionally accepts explicit
`http://localhost:<port>`, `http://127.0.0.1:<port>`, and
`http://[::1]:<port>` entries. Local mode must come from operator environment:
`render workflows dev` sets `RENDER_USE_LOCAL_DEV` for the workflow, or a
loopback HTTP `RENDER_LOCAL_DEV_URL` verifies local mode for the API. Running
on Render disables the HTTP exception. Set the same local origins on both
processes; setting a request URL alone never enables callbacks.

When upgrading a deployment that already uses callbacks, configure approved
origins on both services before deploying. New unapproved requests return 400;
unapproved queued deliveries also fail closed. Polling remains available for
retrieving the reply.

For an approved callback, the `deliver` subtask sends:

- `X-Researcher-Timestamp`: Unix seconds.
- `X-Researcher-Signature`:
  `v1=<HMAC-SHA256(secret, timestamp + "." + rawBody)>`.
- JSON body:
  `{ "trace_id": "...", "reply": {...}, "metadata": {...} }`.

Verify the signature against the raw body before parsing, reject timestamps
outside five minutes, and use a timing-safe comparison. TypeScript code in
this repository can call [`verifyCallback`](../src/callback.ts).

Delivery retries independently of the investigation, so receivers must be
idempotent on `trace_id`. Derive a per-question callback secret, for example
an HMAC of the event ID under one key you keep, instead of sending the same
long-lived secret with every question. Workflow inputs, including callback
secrets, are visible to Dashboard users.

## Integrate another tool

The researcher knows about questions, not about where they come from. A chat
bot (Slack, Discord, Teams), a support-desk app, or an internal web page
integrates as its own service that calls the HTTP API:

1. **Verify and acknowledge the event.** Chat platforms expect a response
   within seconds, so acknowledge first and start the question afterward.
2. **Start a question.** Send the message text as `question`, the platform's
   event ID as the `Idempotency-Key`, routing data such as the channel and
   thread in `metadata`, and a callback URL.
3. **Continue conversations with `follow_up_to`.** Store the latest question
   ID for each thread or ticket, and pass it when the asker replies. The
   researcher reconstructs the conversation, so the integration doesn't
   resend history.
4. **Verify and render the callback.** Use `metadata` to find the thread,
   handle all three reply kinds, and make posting idempotent on `trace_id`.

When rendering:

- escape all model-written text for the destination's markup;
- suppress mentions such as `@everyone` and channel-wide notifications;
- use the trusted `evidence[].url` values as delivered;
- respect message-size limits, shortening detail before the short answer;
- show `failure.reason`, never internal logs or exception text.

Keep the integration in a separate service with its own secrets. Anyone who
can ask through it can read the configured repositories, so restrict who can
ask, for example to an allow-list of channels.

## Run a second deployment

Service and snapshot names must be unique within a workspace. For another
instance:

1. Rename the project and all three services in `render.yaml`.
2. Update the `fromService` workflow name.
3. Choose a different `snapshotName` in `config.ts`.

## Configuration reference

Every variable also appears in [`.env.example`](../.env.example). An empty
string is treated as unset.

### API service

| Variable | Default | Purpose |
|---|---|---|
| `API_TOKEN` | Generated | Authenticates `/v1/*` and signs question IDs |
| `PORT` | `3000` | HTTP port |
| `RENDER_API_KEY` | None | Starts and reads workflow runs |
| `WORKFLOW_SLUG` | `codebase-researcher-workflow` | Builds the `answer_question` task slug; wired by the Blueprint |
| `CALLBACK_ALLOWED_ORIGINS` | Disabled | Comma-separated approved origins; must match the workflow |
| `RENDER_LOCAL_DEV_URL` | None | Uses a local Workflows server instead of Render |

### Workflow service

| Variable | Default | Purpose |
|---|---|---|
| `RENDER_API_KEY` | None | Sandbox operations |
| `RENDER_WORKSPACE_ID` | Resolved | Required when the key sees multiple workspaces |
| `CALLBACK_ALLOWED_ORIGINS` | Disabled | Comma-separated approved origins, checked again at delivery; must match the API |
| `SANDBOX_PROVIDER` | Render on Render, local elsewhere | Sandbox implementation |
| `MODEL_PROVIDER` | `anthropic` | Pi provider |
| `MODEL` | `claude-opus-5` | Model ID |
| Provider key variable | None | For example `ANTHROPIC_API_KEY` |
| `THINKING_LEVEL` | `medium` | Reasoning effort |
| `AGENT_TIMEOUT_MS` | `900000` | Agent deadline |
| `SANDBOX_PROVISION_TIMEOUT_MS` | `300000` | Restore, boot, verify, and manifest deadline |
| `SANDBOX_NETWORK_POLICY` | `allow-list` | `allow-list`, `allow-all`, or `deny-all` |
| `SANDBOX_ALLOWED_DOMAINS` | Model host | Comma-separated HTTPS egress hosts; supports leftmost wildcards |
| `SANDBOX_TIMEOUT_SECONDS` | `1800` | Provider-side termination backstop |
| `SNAPSHOT_NAME` | `config.ts` | Snapshot-name override |
| `REPOS` | None | Repository-list override |

### Snapshot cron

| Variable | Default | Purpose |
|---|---|---|
| `RENDER_API_KEY` | None | Sandbox and snapshot operations |
| `RENDER_WORKSPACE_ID` | Resolved | Workspace selection |
| `GITHUB_TOKEN` | None | Private GitHub reads |
| Other `tokenEnv` variables | None | Tokens declared in `gitCredentials` |
| `SNAPSHOT_NAME` | `config.ts` | Snapshot-name override |
| `REPOS` | None | Repository-list override |

### `pnpm ask`

| Variable | Default | Purpose |
|---|---|---|
| `API_URL` | `http://localhost:3000` | API service URL |
| `API_TOKEN` | None | The API service's `API_TOKEN` |

### Local development and tests

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_REPOS_ROOT` | `.scratch/repos` | Root of local checkouts |
| `LOCAL_RUNNER_ARGS` | None | Extra runner flags, such as `--faux` |
| `LIVE_MODEL_PROVIDER` | None | Enables the live model test |
| `LIVE_MODEL` | Provider default | Overrides the live test model |
