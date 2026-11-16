export type Confidence = "high" | "medium" | "low";

export type Evidence = {
  repository: string;
  commit: string;
  path: string;
  start_line: number;
  end_line: number;
  url?: string;
};

export type FinalAnswer = {
  status: "final_answer";
  answer: string;
  confidence: Confidence;
  observed_in_code: string[];
  inferred_behavior: string[];
  not_established: string[];
  evidence: Evidence[];
  suggested_owner: string;
  escalation_question: string;
};

export type Reply =
  | { kind: "answer"; traceId: string; result: FinalAnswer; model?: string; manifestCreatedAt?: string }
  | {
      kind: "clarification";
      traceId: string;
      result: { status: "needs_clarification"; question: string; why_needed: string };
    }
  | { kind: "failure"; traceId: string; reason: string };

export type Poll =
  | { id: string; status: "running" }
  | { id: string; status: "completed"; trace_id?: string; reply?: Reply }
  | { id: string; status: "failed"; error: string; trace_id?: string };

export type StoredQuestion = {
  id: string;
  question: string;
  createdAt: string;
  followUpTo?: string;
};
