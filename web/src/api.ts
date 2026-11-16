import type { Poll } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "Can’t reach the researcher. Check your connection and try again.");
  }
  const text = await response.text();
  let body: { error?: string; message?: string } | undefined;
  try {
    body = text ? JSON.parse(text) as { error?: string; message?: string } : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw new ApiError(response.status, body?.message ?? body?.error ?? `Request failed (${response.status})`);
  }
  return body as T;
}

export const getSession = () =>
  request<{ authenticated: boolean }>("/session");

export const login = (password: string) =>
  request<void>("/session", { method: "POST", body: JSON.stringify({ password }) });

export const logout = () =>
  request<void>("/session", { method: "DELETE" });

export const startQuestion = (question: string, followUpTo?: string) =>
  request<{ id: string }>("/questions", {
    method: "POST",
    body: JSON.stringify({ question, follow_up_to: followUpTo }),
  });

export const pollQuestion = (id: string) =>
  request<Poll>(`/questions/${encodeURIComponent(id)}`);
