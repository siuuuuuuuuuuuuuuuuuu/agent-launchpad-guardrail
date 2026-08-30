import type {
  Agent,
  AgentRun,
  AuditEntry,
  Grant,
  Message,
  Scope,
  SystemInfo,
  User,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";
let currentUserId = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

/** Mock identity: the selected principal is sent on every request as X-User-Id. */
export function setCurrentUser(userId: string): void {
  currentUserId = userId.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...(currentUserId ? { "X-User-Id": currentUserId } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),

  // Identity & Policy plane
  users: () => request<{ users: User[] }>("/api/users"),
  me: () => request<{ user: User }>("/api/me"),
  grants: (agentId: string) =>
    request<{ grants: Grant[] }>("/api/agents/" + agentId + "/grants"),
  createGrant: (
    agentId: string,
    body: { grantedTo: string; scopes: Scope[]; expiresAt?: string },
  ) =>
    request<{ grant: Grant }>("/api/agents/" + agentId + "/grants", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeGrant: (agentId: string, grantId: string) =>
    request<{ grant: Grant }>(
      "/api/agents/" + agentId + "/grants/" + grantId,
      { method: "DELETE" },
    ),
  audit: (params: Record<string, string> = {}) =>
    request<{ entries: AuditEntry[] }>(
      "/api/audit" +
        (Object.keys(params).length
          ? "?" + new URLSearchParams(params).toString()
          : ""),
    ),
};
