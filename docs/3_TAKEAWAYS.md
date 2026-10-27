# Takeaways

This project is an example of a broader pattern: prepare trusted inputs ahead
of time, run each agent job in a fresh Render Sandbox, and keep orchestration
and validation outside that Sandbox. These are the parts worth reusing.

## Use a scheduled, refreshed snapshot as the handoff

Do expensive and privileged preparation once, then restore its result for
each unit of work.

The hourly cron:

1. resolves exact repository commits;
2. bundles the runner and installs tools in a builder Sandbox;
3. clones with temporary Git credentials;
4. removes those credentials and locks down the filesystem;
5. verifies the result;
6. records a named snapshot.

Questions restore the newest available snapshot with that name. They do not
clone, install packages, or receive Git credentials.

This pattern has several useful properties:

- **Fast jobs:** restoring takes seconds instead of repeating setup.
- **Smaller runtime authority:** investigation Sandboxes need only the model
  API, not package registries or Git hosts.
- **Reproducibility:** a manifest records the exact commits each answer read.
- **Graceful refresh:** stable naming decouples readers from the refresh job.
- **Availability:** keeping the newest two available snapshots covers a restore
  that overlaps a replacement. Failed captures are cleaned up separately and
  never consume those retention slots; a failed refresh leaves the previous
  successful snapshot live.
- **Simple freshness:** an unconditional schedule avoids missed or duplicated
  webhooks and keeps snapshots from expiring.

Use this beyond code research whenever many short-lived jobs share an
expensive base: prepared datasets, toolchains, dependency trees, or compiled
artifacts.

Implementation: [`src/sandbox/render/snapshot.ts`](../src/sandbox/render/snapshot.ts),
[`src/cron.ts`](../src/cron.ts), and
[`sandbox/verify.sh`](../sandbox/verify.sh).

## Put the agent in the Sandbox, not beside it

The model loop, tools, and model-directed shell commands all run inside the
same fresh Sandbox as the read-only repositories. The host does not interpret
tool calls and proxy commands one by one.

That placement gives the agent ordinary local file and process semantics while
the Sandbox contains the consequences:

- repository reads and Git history are fast and local;
- command execution cannot affect the workflow service;
- per-question process and filesystem state disappear at termination;
- the host has a small interface: open, run once, collect events, close.

Keep the trusted control plane outside. The workflow chooses the snapshot and
network policy, uploads bounded input, applies deadlines, validates output,
retries infrastructure failures, and terminates the Sandbox in `finally`.

Implementation: [`src/tasks.ts`](../src/tasks.ts),
[`src/sandbox/interface.ts`](../src/sandbox/interface.ts), and
[`src/sandbox/render/sandbox.ts`](../src/sandbox/render/sandbox.ts).

## Surround the agent with independent security layers

An agent tool policy is not a security boundary. A model can generate an
unexpected shell command, invoke an interpreter, or follow malicious
instructions from a repository. Enforce important properties below the model.

### Filesystem

- Repositories and the runner application are root-owned.
- Checkouts are read-only to the unprivileged `investigator` user.
- Only a private scratch directory is writable.
- Every question restores a fresh Sandbox instead of reusing a contaminated
  process or filesystem.

### Credentials

- Git tokens exist only in the builder and only for cloning.
- Tokens are files, not command arguments, URLs, or persistent Git config.
- A scrub step fails the build if any trace remains.
- The model key is a one-time file deleted when read and again on process exit.
- Tool subprocesses receive an allowlisted environment, not the runner's
  environment.
- The runner's execute-only Node binary makes its process non-dumpable, so
  same-user tool processes cannot read the key from `/proc`.

### Network

- The builder has broad egress but never runs the agent.
- Investigation Sandboxes allow only the model provider's HTTPS host by
  default, with exact and leftmost-wildcard rules available when more hosts
  are required.
- The workflow refuses a Sandbox whose returned policy or rules differ from
  what it requested.
- Egress probes run before work starts.

### Verification

Do not trust that a sequence of setup calls produced the intended state.
Verify the actual filesystem, manifest, credentials, permissions, runner,
memory protection, and network behavior:

- once before creating the snapshot;
- again after restoring every investigation Sandbox.

A failed verification produces no snapshot or no investigation. This makes
security properties executable preconditions instead of comments.

Implementation: [`sandbox/as-runner.sh`](../sandbox/as-runner.sh),
[`sandbox/verify.sh`](../sandbox/verify.sh),
[`sandbox/build/`](../sandbox/build), and
[`src/runner/main.ts`](../src/runner/main.ts).

## Treat guardrails and boundaries differently

The shell filter rejects network clients, installs, mutating Git commands, and
privilege escalation. That improves model behavior and avoids wasted turns,
but approximate shell parsing is bypassable.

Use soft guardrails for:

- clear feedback to the model;
- steering toward supported tools;
- reducing accidental or expensive behavior.

Use hard boundaries for:

- write prevention: Unix ownership and permissions;
- network prevention: Sandbox egress policy;
- secret isolation: one-time files, environment allowlists, and process
  hardening;
- lifetime: fresh Sandboxes and provider-side termination.

Naming which layer enforces each property prevents a convenient policy from
quietly becoming the only defense.

Implementation: [`src/runner/tools.ts`](../src/runner/tools.ts).

## Validate agent output against ground truth

Structured output is only a shape until it is checked.

The submission tool validates every citation against the manifest and actual
checkout: repository, commit, path containment, file type, and line range.
Rejected submissions return actionable errors so the model can repair them.
The trusted host checks the manifest again and constructs evidence links
itself.

Generalize this pattern:

- make the agent submit through one typed operation;
- validate claims against authoritative state before acceptance;
- let the model correct validation failures within a small budget;
- rebuild trusted artifacts—links, IDs, permissions, destinations—outside
  the agent;
- distinguish observed facts, inference, and unknowns in the result schema.

Implementation: [`src/runner/submit.ts`](../src/runner/submit.ts),
[`src/investigation.ts`](../src/investigation.ts), and
`filterEvidence` in [`src/tasks.ts`](../src/tasks.ts).

## Design a narrow, typed host/runner protocol

The host sends one `RunnerInput` object and receives newline-delimited
`RunnerEvent` values. The protocol carries model-independent facts:
transcript, manifest, paths, model selection, timeout, usage, tool activity,
and one terminal result or error.

A narrow protocol:

- keeps Sandbox implementation details out of the agent loop;
- makes local and Render providers interchangeable;
- permits tolerant parsing after a killed process;
- creates one place for redaction and version reporting;
- makes fake and live runners testable against the same contract.

Implementation: [`src/runner/protocol.ts`](../src/runner/protocol.ts) and
[`src/runner/events.ts`](../src/runner/events.ts).

## Make long-running Sandbox work recoverable

A live exec stream can drop while the process continues. The in-Sandbox
script therefore writes structured events and exit status to root-owned files.
The host can poll for completion and download those files even after losing
the stream.

Apply deadlines at several layers:

- agent/session deadline;
- in-Sandbox process timeout and kill grace;
- host wait deadline;
- Sandbox `timeoutSeconds` backstop;
- workflow task timeout.

Cleanup should be idempotent and live in `finally`. A provider-side timeout is
still necessary for the gap where the host dies before cleanup.

Implementation: [`sandbox/run-investigation.sh`](../sandbox/run-investigation.sh),
[`src/sandbox/render/sandbox.ts`](../src/sandbox/render/sandbox.ts), and
[`src/workflow.ts`](../src/workflow.ts).

## Retry infrastructure, not judgment

Retry a failed restore, dropped stream, or terminated Sandbox on fresh
infrastructure. Do not automatically rerun an agent that reached the model
and failed to submit an answer; the same input is likely to spend the budget
again with the same outcome.

Classify failures deliberately:

- infrastructure failures throw so the `investigate` subtask retries;
- model, timeout, and submission failures become explicit replies;
- callback delivery retries independently;
- the parent task always tries to leave the caller with a result.

Implementation: `classifyRun` and `failureReason` in
[`src/tasks.ts`](../src/tasks.ts).

## Make the workflow run the record

The API stores nothing. Each `answer_question` run's input holds the whole
conversation it answered, and its result holds the reply, so the run is both
the job and the database row:

- a signed question ID lets the API read back only the runs it started;
- a follow-up reads the earlier run's transcript and reply, appends the new
  question, and starts a new run, so a chain of follow-ups never needs more
  than the latest ID;
- polling and callbacks return the same stored reply.

Keep integrations such as chat bots and support desks outside, as clients of
the HTTP API. For any webhook-driven integration:

- acknowledge before slow work;
- use the platform event ID as the idempotency key;
- store the latest question ID per thread and send it as `follow_up_to`;
- derive a per-event callback secret and verify callbacks against the raw body;
- make callback handling idempotent;
- escape model text and suppress mentions.

Implementation: [`src/api.ts`](../src/api.ts),
[`src/question.ts`](../src/question.ts), and
[`src/ask.ts`](../src/ask.ts).
