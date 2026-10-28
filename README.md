# codebase-researcher

A template for getting evidence-backed answers to questions about how your code behaves. Post a question to an HTTP API, or run `pnpm ask "..."`. An AI coding agent reads your repositories in a fresh, locked-down Render Sandbox and answers with file-and-line citations that are checked against the exact commit it read.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/codebase-researcher)

The button deploys this repository as is, investigating its example corpus: three public repositories (the Render CLI, SDK, and agent skills). To point it at your own code, fork first and deploy your fork.

Every answer has the same structure: a short answer, a confidence level, what was observed in code, what was inferred, what was not established, file-and-line evidence, a suggested owner, and an escalation-ready question for engineering. When the question is ambiguous, the agent asks one clarifying question instead, and you answer it as a follow-up. A completed poll returns the answer under `reply.result`:

```json
{
  "id": "trn-abc123def456.Kx9mZ7...",
  "status": "completed",
  "reply": {
    "kind": "answer",
    "traceId": "trn-abc123def456",
    "result": {
      "status": "final_answer",
      "answer": "...",
      "confidence": "high",
      "observed_in_code": ["..."],
      "inferred_behavior": ["..."],
      "not_established": ["..."],
      "evidence": [
        {"repository": "owner/repo", "commit": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "path": "src/file.ts", "start_line": 10, "end_line": 25, "url": "https://..."}
      ],
      "suggested_owner": "...",
      "escalation_question": "..."
    }
  }
}
```

## Why it matters

Support and solutions teams field questions the documentation doesn't answer: what a setting really does, why a command fails in one environment, what happens in an edge case. The answer is in the code, so the question goes to engineering, where it waits in a queue or interrupts someone. Often the question that arrives is vague, and the engineer has to work out what is being asked before they can answer it.

The researcher does the first investigation. It reads the source, git history, and tests, and either answers the question or narrows it to the smallest thing an engineer needs to confirm, with a suggested owner.

An answer about code is only useful if you can check it. A model can sound confident and be wrong, so this template:

- separates what the agent saw in the code from what it inferred and what it could not establish;
- rejects any submission whose citations don't exist at the cited commit, file, and line range, so the agent must fix them before it can answer;
- builds evidence links in trusted code from the validated citations, so the model can't supply its own URLs;
- pins every answer to the commits it read.

A reader can follow each link to the exact lines and decide for themselves.

### What it demonstrates on Render

- **Sandboxes:** one fresh, isolated Sandbox per question, restored from a snapshot that a privileged builder Sandbox prepared once. The investigation Sandbox has no git credentials and, by default, can reach only the model provider's API.
- **Workflows:** each question is a durable workflow run with subtasks, per-attempt timeouts, and retries for infrastructure failures. The run is the record of the question and its answer, which is also how a follow-up recovers the conversation.
- **Cron Jobs:** an hourly job rebuilds the repository snapshot, so investigations see recent commits and the snapshot never expires.
- **Blueprints:** one `render.yaml` creates the project, its three services, and their wiring, and prompts for each secret.

## How a question flows

1. A caller posts `{"question": "..."}` to `POST /v1/questions`. The API service starts an `answer_question` workflow run and returns `202 { id }` right away. A follow-up also sends `follow_up_to`, and the API prepends that earlier run's conversation and reply.
2. The workflow's `investigate` subtask restores a fresh Sandbox from the current repository snapshot and verifies that it is locked down.
3. Inside the Sandbox, the runner starts the coding agent with the conversation and the list of repositories and commits. The agent reads code, git history, and search results through read-only tools, then calls `submit_investigation`. Every cited file, commit, and line range is checked against the checkout before the submission is accepted.
4. The workflow returns the result, which the caller polls with `GET /v1/questions/:id`. If the caller included a callback URL, the `deliver` subtask also POSTs the signed result to it.
5. The Sandbox is terminated in a `finally` block and never reused.
6. Separately, an hourly cron job rebuilds the snapshot: it clones the configured repositories into a builder Sandbox, locks them down, and keeps the newest two snapshots so a question that started restoring just before a new build can finish.

## Security

- Every question gets its own Sandbox, restored from an immutable snapshot. No state carries between questions.
- Repositories are root-owned and read-only inside the Sandbox, and the runner runs as an unprivileged user.
- The model API key arrives as a one-time file that the runner deletes on read. The runner's Node binary is execute-only and signal-triggered debugging is disabled, protecting its memory from the agent's commands. The snapshot build and every restored Sandbox must verify both protections, or the build fails and the Sandbox gets no work.
- HTTPS egress defaults to the model provider's API host and can be replaced with an exact host and leftmost-wildcard allow-list. DNS still resolves arbitrary names.
- Git tokens exist only in the builder Sandbox while it clones. They are scrubbed and verified absent before the snapshot is taken.
- Callbacks are disabled until the operator sets the same `CALLBACK_ALLOWED_ORIGINS` on the API and workflow. Both services enforce exact HTTPS origins, and delivery rejects redirects. Polling works without callback configuration.
- Anyone who holds `API_TOKEN` can read the configured repositories through the researcher, so share it like a read token for those repositories.
- The API signs question IDs with a separate, server-only `QUESTION_ID_SECRET`. The Blueprint generates it; keep it stable across API replicas and restarts, and never share it with callers or the workflow. See [question-ID rotation and migration](docs/1_EXTENSION.md#question-id-signing-and-rotation).

The architecture guide's [trust boundaries](docs/2_ARCHITECTURE.md#trust-boundaries)
section explains these properties and the residual risks. Runtime hardening changes reach investigation Sandboxes only after a successful snapshot refresh; deploying the services alone does not update existing snapshots.

## Get running

You need a Render workspace with Sandboxes access in the Oregon region, a
Render API key, and a model API key (Anthropic by default). The snapshot cron
runs on a paid Standard instance; see the
[prerequisites](docs/0_QUICKSTART.md#prerequisites) before deploying.

1. Fork this repository. Edit `config.ts` to list your repositories and `prompt.md` to describe your product. Commit and push.
2. In the Render Dashboard, create a Blueprint from your fork and paste the secrets it asks for.
3. Trigger the `codebase-researcher-snapshots` cron job once to build the first snapshot (about 5 minutes).
4. Ask a question from your checkout, using the API service's URL and its generated `API_TOKEN`:

   ```bash
   pnpm install
   API_URL=https://<your-api-service>.onrender.com API_TOKEN=... \
     pnpm ask "How does the CLI pick a workspace in CI?"
   ```

   An investigation usually takes one to two minutes. [Ask your first question](docs/0_QUICKSTART.md#ask-your-first-question) shows the same request with curl.

To try it on your machine first, without a Sandbox or a model key, clone a couple of repositories into `.scratch/repos/` and run the workflow and the API locally with the runner's `--faux` mode, which follows a fixed script instead of calling a model. [Run it locally](docs/0_QUICKSTART.md#run-it-locally) has the commands.

## Learn more

- [docs/0_QUICKSTART.md](docs/0_QUICKSTART.md): deploy, ask a question, follow up, develop locally, and operate the service.
- [docs/1_EXTENSION.md](docs/1_EXTENSION.md): configure the corpus, model, and agent, or integrate the API into another tool.
- [docs/2_ARCHITECTURE.md](docs/2_ARCHITECTURE.md): repository layout, core execution paths, interfaces, and trust boundaries.
- [docs/3_TAKEAWAYS.md](docs/3_TAKEAWAYS.md): reusable patterns for agents, scheduled snapshots, security, and guardrails.

## License

MIT. See [LICENSE](LICENSE).
