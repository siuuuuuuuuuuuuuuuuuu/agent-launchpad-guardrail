export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type UserRole = "owner-capable" | "standard";
export type Scope = "invoke" | "view_config" | "edit_config" | "view_runs";

export interface User {
  id: string;
  name: string;
  role: UserRole;
}

export interface Grant {
  id: string;
  agentId: string;
  grantedTo: string;
  grantedBy: string;
  scopes: Scope[];
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actorUserId: string;
  agentId: string | null;
  action: string;
  requestedScope: string | null;
  decision: "allow" | "deny";
  result: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  ownerId: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
