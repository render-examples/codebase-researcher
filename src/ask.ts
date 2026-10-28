import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Reply } from "./question.ts";

const USAGE = `Usage: pnpm ask [--follow-up <question id>] [--json] "<question>"

Posts the question to $API_URL (default http://localhost:3000) with $API_TOKEN, waits for the
investigation to finish, and prints the reply. --follow-up continues an earlier question, for
example to answer a clarification. --json prints the raw reply.`;

const POLL_MS = 5_000;

type Poll = { status: "running" } | { status: "completed"; reply: Reply } | { status: "failed"; error: string; trace_id: string };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "follow-up": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const question = positionals.join(" ").trim();
const apiUrl = (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiToken = process.env.API_TOKEN;
if (values.help || !question || !apiToken) {
  console.error(apiToken || values.help ? USAGE : `API_TOKEN is required.\n\n${USAGE}`);
  process.exit(values.help ? 0 : 2);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const { id } = await api<{ id: string }>("/v1/questions", {
  method: "POST",
  body: JSON.stringify({ question, follow_up_to: values["follow-up"] }),
});
console.error(`Investigating (question ${id}). This usually takes one to two minutes.`);

let poll: Poll;
const started = Date.now();
while ((poll = await api<Poll>(`/v1/questions/${encodeURIComponent(id)}`)).status === "running") {
  process.stderr.write(`\r  ${Math.round((Date.now() - started) / 1000)}s`);
  await sleep(POLL_MS);
}
process.stderr.write("\n");

if (poll.status === "failed") {
  console.error(`The workflow run failed: ${poll.error} Trace ${poll.trace_id}.`);
  process.exit(1);
}
if (values.json) {
  console.log(JSON.stringify(poll.reply, null, 2));
} else {
  console.log(render(poll.reply));
}
process.exit(poll.reply.kind === "failure" ? 1 : 0);

function render(reply: Reply): string {
  const followUp = (hint: string) => `\nFollow up: pnpm ask --follow-up ${id} "${hint}"`;
  const list = (title: string, items: string[]) => (items.length ? [`\n${title}`, ...items.map((i) => `  - ${i}`)] : []);
  switch (reply.kind) {
    case "answer": {
      const r = reply.result;
      return [
        `Answer (${r.confidence} confidence)`,
        r.answer,
        ...list("Observed in code", r.observed_in_code),
        ...list("Inferred", r.inferred_behavior),
        ...list("Not established", r.not_established),
        ...list("Evidence", r.evidence.map((e) => `${e.repository} ${e.path}:${e.start_line}-${e.end_line}\n    ${e.url}`)),
        `\nSuggested owner: ${r.suggested_owner}`,
        `Question for engineering: ${r.escalation_question}`,
        followUp("<your next question>"),
      ].join("\n");
    }
    case "clarification":
      return [
        "The researcher needs one detail before it can answer:",
        reply.result.question,
        `\nWhy: ${reply.result.why_needed}`,
        followUp("<your answer>"),
      ].join("\n");
    case "failure":
      return `I couldn't complete this investigation: ${reply.reason}. Trace ${reply.traceId}.`;
  }
}
