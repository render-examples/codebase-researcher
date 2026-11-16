import type { StoredQuestion } from "./types.ts";

const KEY = "codebase-researcher.questions.v1";
const MAX_QUESTIONS = 100;

const isQuestion = (value: unknown): value is StoredQuestion => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.question === "string" &&
    typeof item.createdAt === "string" &&
    (item.followUpTo === undefined || typeof item.followUpTo === "string")
  );
};

export function loadQuestions(): StoredQuestion[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(isQuestion).slice(0, MAX_QUESTIONS) : [];
  } catch {
    return [];
  }
}

export function saveQuestions(questions: StoredQuestion[]): { questions: StoredQuestion[]; persisted: boolean } {
  const next = questions.slice(0, MAX_QUESTIONS);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    return { questions: next, persisted: true };
  } catch {
    return { questions: next, persisted: false };
  }
}

export function addQuestion(
  questions: StoredQuestion[],
  question: StoredQuestion,
): { questions: StoredQuestion[]; persisted: boolean } {
  return saveQuestions([question, ...questions.filter((item) => item.id !== question.id)]);
}

export function clearQuestions(): boolean {
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** Oldest-to-newest local conversation ending at `id`. */
export function questionChain(questions: StoredQuestion[], id: string): StoredQuestion[] {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const chain: StoredQuestion[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.followUpTo ? byId.get(current.followUpTo) : undefined;
  }
  return chain;
}
