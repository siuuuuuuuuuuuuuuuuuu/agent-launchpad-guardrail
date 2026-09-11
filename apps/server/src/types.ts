export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";
export type MessageRole = "user" | "assistant";

export type UserRole = "owner-capable" | "standard";
export type Scope = "invoke" | "view_config" | "edit_config" | "view_runs";

// ---------------------------------------------------------------------------
// Runtime guardrails (data shapes only — the engine lives in ./guardrail/).
//
// A GuardrailPolicy rides on every Agent. The GuardrailEngine evaluates it at
// four points in the run path: the prompt before Codex starts, the sandbox
// mode passed to Codex, each command / file change / tool call while the run
// executes, and the final output before it is stored. Every non-clean decision
// is written to the audit log, exactly like an authorization decision.
// ---------------------------------------------------------------------------

/** Per-Agent Codex sandbox ceiling. `danger-full-access` is never selectable here. */
export type GuardrailSandboxMode = "read-only" | "workspace-write";

export type GuardrailRuleKind =
  | "prompt_pattern"
  | "command_pattern"
  | "path_pattern"
  | "output_pattern";

/** `deny` blocks (or kills the run); `flag` allows but records an audit entry. */
export type GuardrailEffect = "deny" | "flag";

export interface GuardrailRule {
  id: string;
  kind: GuardrailRuleKind;
  /** JavaScript regular-expression source, matched case-insensitively. */
  pattern: string;
  effect: GuardrailEffect;
  /** Human-readable reason, shown in the audit entry and to the caller. */
  message: string;
  /** Platform-baseline rule: always applied, cannot be removed by the owner. */
  builtin?: boolean;
}

export interface GuardrailPolicy {
  /** Codex `--sandbox` mode for this Agent. May only tighten the platform ceiling. */
  sandboxMode: GuardrailSandboxMode;
  /** Allow the Runtime outbound network access. Default false. */
  networkAccess: boolean;
  /** Owner-defined rules, evaluated after the always-on baseline. */
  rules: GuardrailRule[];
  updatedAt: string;
}

/** One agent action, normalised from the Codex event stream for the live monitor. */
export interface RuntimeActionEvent {
  kind: "command" | "file_change" | "mcp_tool_call";
  /** The command line, changed path, or `server/tool` — whatever a rule matches. */
  value: string;
  /** `started` is the pre-execution-ish gate; `completed` is after the fact. */
  phase: "started" | "completed";
}

/** What the runner's `onAction` hook returns: `allow: false` aborts the run. */
export interface GuardrailActionVerdict {
  allow: boolean;
}

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
  guardrailPolicy: GuardrailPolicy;
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
  version: 3;
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
  /** Codex sandbox mode for this run. Defaults to the server config when omitted. */
  sandboxMode?: GuardrailSandboxMode;
  /** Whether the run may reach the network. Defaults to false. */
  networkAccess?: boolean;
  /**
   * Live guardrail hook. Called for each command / file change / tool call the
   * agent performs. Returning `{ allow: false }` terminates the run and makes
   * `runner.run()` reject with a `GuardrailError`.
   */
  onAction?: (event: RuntimeActionEvent) => GuardrailActionVerdict;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
