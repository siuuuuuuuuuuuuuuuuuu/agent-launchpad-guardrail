export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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

// Audit entry shape lives in ./audit-log/types.ts (owned by the Audit subsystem).

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  actorUserId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 2;
  users: User[];
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  grants: Grant[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  actorUserId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
