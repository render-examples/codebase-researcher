import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import * as api from "./api.ts";
import { addQuestion, clearQuestions, loadQuestions, questionChain } from "./storage.ts";
import type { Confidence, FinalAnswer, Poll, Reply, StoredQuestion } from "./types.ts";

const POLL_MS = 3_000;

const shortId = (id: string) => id.split(".", 1)[0]?.slice(-12) ?? id.slice(0, 12);
const titleFor = (text: string) => text.split(/\r?\n/, 1)[0]?.trim() || "Untitled question";

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await api.login(password);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="wordmark">Render</div>
        <h1>Codebase Researcher</h1>
        <p className="lede">Evidence-backed answers from the exact code your agent read.</p>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="button button-primary" type="submit" disabled={!password || submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const bars = confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
  return (
    <span className={`confidence confidence-${confidence}`}>
      <span className="meter" aria-hidden="true">
        {[1, 2, 3].map((bar) => <span key={bar} className={bar <= bars ? "active" : ""} />)}
      </span>
      {confidence} confidence
    </span>
  );
}

function ListSection({
  title,
  items,
  marker,
}: {
  title: string;
  items: string[];
  marker: "observed" | "inferred" | "unknown";
}) {
  return (
    <details className="answer-section" open>
      <summary>
        <span className="section-title">{title}</span>
        <span className="count">{items.length}</span>
      </summary>
      {items.length ? (
        <ul className={`claim-list marker-${marker}`}>
          {items.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      ) : <p className="none">None</p>}
    </details>
  );
}

function AnswerCard({ answer, traceId }: { answer: FinalAnswer; traceId: string }) {
  const copyEscalation = () => {
    void navigator.clipboard?.writeText(
      `${answer.escalation_question}\n\nContext: ${answer.answer}\nTrace: ${traceId}`,
    );
  };

  return (
    <article className="card answer-card">
      <div className="answer-top">
        <div>
          <h3 className="section-title">Short answer</h3>
          <p className="answer-copy">{answer.answer}</p>
        </div>
        <ConfidenceBadge confidence={answer.confidence} />
      </div>
      <ListSection title="Observed in code" items={answer.observed_in_code} marker="observed" />
      <ListSection title="Inferred behavior" items={answer.inferred_behavior} marker="inferred" />
      <ListSection title="Not established" items={answer.not_established} marker="unknown" />
      <details className="answer-section" open>
        <summary>
          <span className="section-title">Evidence</span>
          <span className="count">{answer.evidence.length}</span>
        </summary>
        {answer.evidence.length ? (
          <ul className="evidence-list">
            {answer.evidence.map((evidence, index) => {
              const label = (
                <>
                  <span>{evidence.repository}</span>{" "}
                  {evidence.path}:{evidence.start_line}–{evidence.end_line}{" "}
                  <small>@ {evidence.commit.slice(0, 12)}</small>
                </>
              );
              return (
                <li key={`${evidence.repository}:${evidence.path}:${index}`}>
                  {evidence.url
                    ? <a href={evidence.url} target="_blank" rel="noreferrer">{label}</a>
                    : label}
                </li>
              );
            })}
          </ul>
        ) : <p className="none">None</p>}
      </details>
      <section className="answer-section">
        <h3 className="section-title">Suggested engineering owner</h3>
        <p>{answer.suggested_owner}</p>
      </section>
      <section className="answer-section escalation">
        <div className="section-head">
          <h3 className="section-title">Escalation-ready question</h3>
          <button className="button button-small" type="button" onClick={copyEscalation}>Copy</button>
        </div>
        <p>{answer.escalation_question}</p>
      </section>
      <footer className="reply-footer">Trace <code>{traceId}</code></footer>
    </article>
  );
}

function ReplyCard({ reply }: { reply: Reply }) {
  switch (reply.kind) {
    case "answer":
      return <AnswerCard answer={reply.result} traceId={reply.traceId} />;
    case "clarification":
      return (
        <article className="card simple-card clarification-card">
          <div className="card-kicker">Needs your reply</div>
          <p className="prominent">{reply.result.question}</p>
          <h3 className="section-title">Why this is needed</h3>
          <p>{reply.result.why_needed}</p>
          <footer className="reply-footer">Trace <code>{reply.traceId}</code></footer>
        </article>
      );
    case "failure":
      return (
        <article className="card simple-card failure-card">
          <div className="card-kicker">Investigation failed</div>
          <p>{reply.reason}</p>
          <footer className="reply-footer">Trace <code>{reply.traceId}</code></footer>
        </article>
      );
  }
}

function PollCard({ poll }: { poll?: Poll }) {
  if (!poll || poll.status === "running") {
    return (
      <article className="card progress-card" aria-live="polite">
        <span className="activity-dot" />
        <div>
          <h3>Investigating</h3>
          <p>The researcher is reading code and validating its citations. This usually takes one to two minutes.</p>
        </div>
      </article>
    );
  }
  if (poll.status === "failed") {
    return (
      <article className="card simple-card failure-card">
        <div className="card-kicker">Investigation failed</div>
        <p>{poll.error}</p>
        {poll.trace_id && <footer className="reply-footer">Trace <code>{poll.trace_id}</code></footer>}
      </article>
    );
  }
  if (poll.reply) return <ReplyCard reply={poll.reply} />;
  return (
    <article className="card simple-card failure-card">
      <div className="card-kicker">No reply recorded</div>
      <p>The workflow completed without a result.</p>
    </article>
  );
}

function Composer({
  followUp,
  disabled,
  onSubmit,
}: {
  followUp: boolean;
  disabled: boolean;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const question = text.trim();
    if (!question || disabled || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(question);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t start the investigation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor="question" className="section-title">
        {followUp ? "Follow up" : "Ask a question"}
      </label>
      <textarea
        id="question"
        rows={followUp ? 3 : 7}
        maxLength={8000}
        value={text}
        placeholder={followUp ? "Ask a related question or answer the clarification…" : "How does this code behave?"}
        onChange={(event) => setText(event.target.value)}
        disabled={disabled || submitting}
      />
      <div className="composer-footer">
        <span className="hint">
          {followUp ? "The previous exchange is included automatically." : "Questions and IDs are saved in this browser."}
        </span>
        <button className="button button-primary" type="submit" disabled={!text.trim() || disabled || submitting}>
          {submitting ? "Submitting…" : followUp ? "Send follow-up" : "Investigate"}
        </button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>
  );
}

function Header({
  onNew,
  onLogout,
}: {
  onNew: () => void;
  onLogout: () => void;
}) {
  return (
    <header className="app-header">
      <button className="brand" type="button" onClick={onNew}>Codebase Researcher</button>
      <span className="spacer" />
      <button className="button button-ghost" type="button" onClick={onNew}>New question</button>
      <button className="button button-ghost" type="button" onClick={onLogout}>Sign out</button>
    </header>
  );
}

function History({
  questions,
  selectedId,
  polls,
  onSelect,
  onClear,
}: {
  questions: StoredQuestion[];
  selectedId: string | null;
  polls: Record<string, Poll>;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <aside className="history">
      <div className="history-head">
        <h2>Recent questions</h2>
        {questions.length > 0 && <button type="button" onClick={onClear}>Clear</button>}
      </div>
      {questions.length ? (
        <ul>
          {questions.map((question) => {
            const status = polls[question.id]?.status ?? "saved";
            return (
              <li key={question.id}>
                <button
                  type="button"
                  className={question.id === selectedId ? "selected" : ""}
                  onClick={() => onSelect(question.id)}
                >
                  <span>{titleFor(question.question)}</span>
                  <small><i className={`status-dot status-${status}`} />{status}</small>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="history-empty">Your local question history will appear here.</p>}
    </aside>
  );
}

function Researcher({ onExpired }: { onExpired: () => void }) {
  const [questions, setQuestions] = useState<StoredQuestion[]>(loadQuestions);
  const [selectedId, setSelectedId] = useState<string | null>(questions[0]?.id ?? null);
  const [polls, setPolls] = useState<Record<string, Poll>>({});
  const [loadError, setLoadError] = useState("");
  const [persistenceWarning, setPersistenceWarning] = useState("");
  const chain = useMemo(
    () => selectedId ? questionChain(questions, selectedId) : [],
    [questions, selectedId],
  );
  const chainKey = chain.map((question) => question.id).join("|");

  const load = useCallback(async (id: string) => {
    try {
      const poll = await api.pollQuestion(id);
      setPolls((current) => ({ ...current, [id]: poll }));
      setLoadError("");
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 401) {
        onExpired();
      } else if (err instanceof api.ApiError && err.status === 404) {
        setPolls((current) => ({
          ...current,
          [id]: { id, status: "failed", error: "This saved question is no longer available." },
        }));
        setLoadError("");
      } else {
        setLoadError(err instanceof Error ? err.message : "Couldn’t refresh this question");
      }
    }
  }, [onExpired]);

  useEffect(() => {
    for (const question of chain) void load(question.id);
  }, [chainKey, load]);

  const latestId = chain.at(-1)?.id;
  const latestStatus = latestId ? polls[latestId]?.status : undefined;
  useEffect(() => {
    if (!latestId || latestStatus === "completed" || latestStatus === "failed") return;
    const timer = window.setInterval(() => void load(latestId), POLL_MS);
    return () => window.clearInterval(timer);
  }, [latestId, latestStatus, load]);

  const create = async (text: string) => {
    const followUpTo = selectedId && polls[selectedId]?.status === "completed" ? selectedId : undefined;
    let id: string;
    try {
      ({ id } = await api.startQuestion(text, followUpTo));
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 401) onExpired();
      throw err;
    }
    const question: StoredQuestion = {
      id,
      question: text,
      createdAt: new Date().toISOString(),
      ...(followUpTo ? { followUpTo } : {}),
    };
    const saved = addQuestion(questions, question);
    setQuestions(saved.questions);
    if (!saved.persisted) {
      setPersistenceWarning("This question is available now, but this browser blocked saving it to local history.");
    }
    setPolls((current) => ({ ...current, [id]: { id, status: "running" } }));
    setSelectedId(id);
  };

  const selectedPoll = selectedId ? polls[selectedId] : undefined;
  const canFollowUp = selectedPoll?.status === "completed" && Boolean(selectedPoll.reply);
  const running = selectedPoll?.status === "running";

  const [logoutError, setLogoutError] = useState("");

  const signOut = async () => {
    setLogoutError("");
    try {
      await api.logout();
      onExpired();
    } catch {
      setLogoutError("Couldn’t confirm sign-out. Please try Sign out again before leaving this browser.");
    }
  };

  return (
    <>
      <Header onNew={() => setSelectedId(null)} onLogout={() => void signOut()} />
      <div className="shell">
        <History
          questions={questions}
          selectedId={selectedId}
          polls={polls}
          onSelect={setSelectedId}
          onClear={() => {
            if (!clearQuestions()) {
              setPersistenceWarning("This browser blocked clearing local question history.");
            }
            setQuestions([]);
            setSelectedId(null);
            setPolls({});
          }}
        />
        <main className="workspace">
          {logoutError && <p className="error-text" role="alert">{logoutError}</p>}
          {persistenceWarning && <p className="warning" role="status">{persistenceWarning}</p>}
          {selectedId ? (
            <>
              <div className="question-head">
                <span className="eyebrow">Question {shortId(selectedId)}</span>
                <h1>{titleFor(chain.at(-1)?.question ?? "")}</h1>
              </div>
              <div className="thread">
                {chain.map((question) => (
                  <div className="turn" key={question.id}>
                    <div className="user-message">
                      <div className="message-meta">
                        <span>You</span>
                        <time dateTime={question.createdAt}>{new Date(question.createdAt).toLocaleString()}</time>
                      </div>
                      <p>{question.question}</p>
                    </div>
                    <PollCard poll={polls[question.id]} />
                  </div>
                ))}
              </div>
              {loadError && <p className="error-text" role="alert">{loadError}</p>}
              {canFollowUp && <Composer followUp disabled={false} onSubmit={create} />}
              {running && <p className="hint centered">Follow-ups become available when this investigation finishes.</p>}
            </>
          ) : (
            <section className="welcome">
              <span className="eyebrow">Commit-pinned research</span>
              <h1>Ask how your code behaves.</h1>
              <p>
                The researcher reads source and history in a fresh Sandbox, validates every citation,
                and separates observed facts from inference.
              </p>
              <Composer followUp={false} disabled={false} onSubmit={create} />
            </section>
          )}
        </main>
      </div>
    </>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return <main className="loading">{children}</main>;
}

export function App() {
  const [session, setSession] = useState<"loading" | "authenticated" | "anonymous" | "error">("loading");

  useEffect(() => {
    api.getSession()
      .then(({ authenticated }) => setSession(authenticated ? "authenticated" : "anonymous"))
      .catch(() => setSession("error"));
  }, []);

  if (session === "loading") return <Loading>Loading researcher…</Loading>;
  if (session === "error") {
    return (
      <Loading>
        Couldn’t reach the researcher.
        <button className="button" type="button" onClick={() => window.location.reload()}>Retry</button>
      </Loading>
    );
  }
  if (session === "anonymous") return <Login onAuthenticated={() => setSession("authenticated")} />;
  return <Researcher onExpired={() => setSession("anonymous")} />;
}
