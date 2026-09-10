import { randomUUID } from "node:crypto";
import type { AuditLogger } from "./audit-log/logger.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { enforce } from "./enforcement.js";
import { GuardrailError, HttpError, RunCancelledError } from "./errors.js";
import { GuardrailEngine, type GuardrailDecision } from "./guardrail/engine.js";
import { defaultGuardrailPolicy } from "./guardrail/policy-defaults.js";
import type { PolicyService } from "./policy.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  GuardrailActionVerdict,
  GuardrailPolicy,
  Message,
  RuntimeActionEvent,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  private readonly engine: GuardrailEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly policy: PolicyService,
    private readonly audit: AuditLogger,
    engine?: GuardrailEngine,
  ) {
    this.engine = engine ?? GuardrailEngine.fromConfig(config);
  }

  /** The runtime guardrail engine, exposed for the policy-editing routes. */
  get guardrail(): GuardrailEngine {
    return this.engine;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  /** Non-throwing agent lookup for a run id, used by the enforcement layer. */
  findRunAgentId(runId: string): string | null {
    return (
      this.store.snapshot().runs.find((item) => item.id === runId)?.agentId ?? null
    );
  }

  async createAgent(input: CreateAgentInput, actorUserId: string): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      ownerId: actorUserId,
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      guardrailPolicy: defaultGuardrailPolicy(timestamp),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  getGuardrailPolicy(id: string): GuardrailPolicy {
    return this.getAgent(id).guardrailPolicy;
  }

  /** Replace an Agent's guardrail policy. Validated + normalised by the engine. */
  async setGuardrailPolicy(
    id: string,
    input: Parameters<GuardrailEngine["normalizePolicyInput"]>[0],
  ): Promise<GuardrailPolicy> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing guardrails");
    }
    const normalized = this.engine.normalizePolicyInput(input);
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing guardrails");
      }
      agent.guardrailPolicy = normalized;
      agent.updatedAt = now();
      return structuredClone(normalized);
    });
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    actorUserId: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      actorUserId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      guardrailMode: this.config.guardrailMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    const runtimeAudits: Promise<unknown>[] = [];
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      // Checkpoint 2 (authorization): re-verify at the Runtime boundary. A grant
      // revoked between request admission and Codex invocation is refused here,
      // and a request that bypassed the Fastify boundary never reaches Codex.
      await enforce({
        actorUserId: run.actorUserId,
        agentId: agentAtStart.id,
        action: "invoke",
        policy: this.policy,
        audit: this.audit,
        checkpoint: "runtime",
      });

      const policy = agentAtStart.guardrailPolicy;

      // Guardrail A — screen the prompt + instructions before Codex starts.
      const preflight = this.engine.evaluatePrompt(
        policy,
        run.prompt,
        agentAtStart.instructions,
      );
      await this.recordGuardrail(
        agentAtStart.id,
        { id: run.actorUserId, type: "human" },
        "guardrail.prompt",
        "guardrail-preflight",
        preflight,
        run.prompt,
      );
      if (!preflight.proceed) {
        throw new GuardrailError(
          "Prompt blocked by a runtime guardrail — " + preflight.reason,
          preflight.ruleId,
        );
      }

      // Guardrail B — the sandbox mode + network flag actually handed to Codex.
      const sandbox = this.engine.resolveSandbox(policy);

      // Guardrail C — live monitor: evaluate every command / file change / tool
      // call as it streams back; a deny verdict aborts the run.
      const seen = new Set<string>();
      const onAction = (event: RuntimeActionEvent): GuardrailActionVerdict => {
        const decision = this.engine.evaluateAction(
          policy,
          event,
          agentAtStart.workspacePath,
        );
        if (decision.effect !== "none") {
          const key = event.kind + "\0" + event.value + "\0" + decision.effect;
          if (!seen.has(key)) {
            seen.add(key);
            runtimeAudits.push(
              this.recordGuardrail(
                agentAtStart.id,
                { id: agentAtStart.id, type: "agent" },
                "guardrail." + event.kind,
                "guardrail-runtime",
                decision,
                event.value,
              ),
            );
          }
        }
        return { allow: decision.proceed };
      };

      const result = await this.runner.run({
        agentId: agentAtStart.id,
        actorUserId: run.actorUserId,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        sandboxMode: sandbox.sandboxMode,
        networkAccess: sandbox.networkAccess,
        onAction,
      });
      await Promise.allSettled(runtimeAudits);

      // Guardrail D — screen the final agent message before it is stored.
      const screen = this.engine.screenOutput(policy, result.output);
      if (screen.matched.length > 0) {
        const outcome: Pick<
          GuardrailDecision,
          "proceed" | "effect" | "reason" | "ruleId"
        > = {
          proceed: screen.proceed,
          effect: screen.proceed ? "flag" : "deny",
          reason: screen.reason,
        };
        const matchedRuleId = screen.matched[0]?.ruleId;
        if (matchedRuleId) outcome.ruleId = matchedRuleId;
        await this.recordGuardrail(
          agentAtStart.id,
          { id: agentAtStart.id, type: "agent" },
          "guardrail.output",
          "guardrail-output",
          outcome,
          screen.redactions + " sensitive span(s)",
        );
      }
      if (!screen.proceed) {
        throw new GuardrailError("Output blocked by a runtime guardrail — " + screen.reason);
      }
      const finalOutput = screen.output;

      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = finalOutput;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: finalOutput,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      await Promise.allSettled(runtimeAudits);
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const blocked = error instanceof GuardrailError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : blocked ? "blocked" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            // A guardrail block is not an Agent fault — it returns to ready.
            agent.status = cancelled || blocked ? "ready" : "error";
          }
          agent.lastError = cancelled || blocked ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  /** Write one audit entry for a non-clean guardrail decision. */
  private async recordGuardrail(
    agentId: string,
    actor: { id: string; type: "human" | "agent" },
    action: string,
    checkpoint: string,
    decision: Pick<GuardrailDecision, "proceed" | "effect" | "reason" | "ruleId">,
    value: string,
  ): Promise<void> {
    if (decision.effect === "none") return;
    await this.audit.record({
      actor,
      action,
      target: { type: "agent", id: agentId },
      decision: decision.effect === "deny" ? "deny" : "allow",
      payload: {
        checkpoint,
        ruleId: decision.ruleId ?? null,
        reason: decision.reason,
        enforced: decision.effect === "deny" ? !decision.proceed : true,
        value: value.length > 200 ? value.slice(0, 200) + "…" : value,
      },
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
