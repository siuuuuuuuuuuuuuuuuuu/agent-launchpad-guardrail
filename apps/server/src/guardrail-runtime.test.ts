import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AuditLogger } from "./audit-log/logger.js";
import { MemoryAuditStore } from "./audit-log/store/MemoryAuditStore.js";
import { loadConfig } from "./config.js";
import { GuardrailError } from "./errors.js";
import { GuardrailEngine } from "./guardrail/engine.js";
import { PolicyService } from "./policy.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

// Runtime guardrails end to end: the engine is consulted inside AgentService
// while a run executes, blocked runs land as `blocked` (not `failed`), the
// Agent recovers to `ready`, and every non-clean decision is in the audit log.

const OWNER = "user-alice";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A runner that replays scripted actions through the guardrail `onAction` hook. */
class ScriptedRunner implements AgentRunner {
  constructor(
    private readonly script: {
      actions?: { kind: "command" | "file_change" | "mcp_tool_call"; value: string }[];
      output?: string;
    },
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    for (const action of this.script.actions ?? []) {
      const verdict = request.onAction?.({ ...action, phase: "started" });
      if (verdict && !verdict.allow) {
        throw new GuardrailError("Run blocked by a runtime guardrail — " + action.value);
      }
    }
    return {
      output: this.script.output ?? "done: " + request.prompt,
      threadId: request.threadId ?? "thread-1",
      usage: null,
    };
  }
  async cancel() {
    return false;
  }
  async isAvailable() {
    return true;
  }
}

async function harness(
  runner: AgentRunner,
  mode: "enforce" | "monitor" | "off" = "enforce",
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-guardrail-rt-"));
  dirs.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    GUARDRAIL_MODE: mode,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const auditStore = new MemoryAuditStore();
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new PolicyService(store),
    new AuditLogger(auditStore),
    GuardrailEngine.fromConfig(config),
  );
  await service.initialize();
  return { service, auditStore };
}

describe("runtime guardrails", () => {
  it("blocks a prompt that trips a deny rule before the runner is called", async () => {
    let ran = false;
    const runner: AgentRunner = {
      run: async () => {
        ran = true;
        return { output: "x", threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, auditStore } = await harness(runner);
    const agent = await service.createAgent({ name: "Guarded" }, OWNER);
    await service.setGuardrailPolicy(agent.id, {
      sandboxMode: "workspace-write",
      networkAccess: false,
      rules: [
        { kind: "prompt_pattern", pattern: "drop the database", effect: "deny", message: "no" },
      ],
    });

    const { run } = await service.sendMessage(agent.id, "please drop the database now", OWNER);
    await expect.poll(() => service.getRun(run.id).status).toBe("blocked");
    expect(ran).toBe(false);
    expect(service.getAgent(agent.id).status).toBe("ready");

    const audit = await auditStore.query({ action: "guardrail.prompt" });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.decision).toBe("deny");
  });

  it("kills a run when the live monitor denies a command", async () => {
    const runner = new ScriptedRunner({ actions: [{ kind: "command", value: "rm -rf /" }] });
    const { service, auditStore } = await harness(runner);
    const agent = await service.createAgent({ name: "Monitored" }, OWNER);

    const { run } = await service.sendMessage(agent.id, "clean up", OWNER);
    await expect.poll(() => service.getRun(run.id).status).toBe("blocked");
    expect(service.getRun(run.id).error).toContain("guardrail");
    expect(service.getAgent(agent.id).status).toBe("ready");

    const audit = await auditStore.query({ action: "guardrail.command" });
    expect(audit.entries[0]?.decision).toBe("deny");
    expect(audit.entries[0]?.actor.type).toBe("agent");
  });

  it("redacts a secret in the final output and still completes", async () => {
    const runner = new ScriptedRunner({
      output: "deploy key: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ done",
    });
    const { service, auditStore } = await harness(runner);
    const agent = await service.createAgent({ name: "Leaky" }, OWNER);

    const { run } = await service.sendMessage(agent.id, "print the key", OWNER);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const stored = service.getRun(run.id).output ?? "";
    expect(stored).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(stored).toContain("[REDACTED:baseline.output-openai-key]");

    const messages = service.getMessages(agent.id);
    expect(messages[1]?.content).toContain("[REDACTED:");

    const audit = await auditStore.query({ action: "guardrail.output" });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.decision).toBe("allow");
  });

  it("monitor mode records the decision but does not block", async () => {
    const runner = new ScriptedRunner({ actions: [{ kind: "command", value: "rm -rf /" }] });
    const { service, auditStore } = await harness(runner, "monitor");
    const agent = await service.createAgent({ name: "Observed" }, OWNER);

    const { run } = await service.sendMessage(agent.id, "clean up", OWNER);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const audit = await auditStore.query({ action: "guardrail.command" });
    expect(audit.entries[0]?.decision).toBe("deny");
    expect(audit.entries[0]?.payload).toMatchObject({ enforced: false });
  });

  it("passes the resolved sandbox + network flag to the runner", async () => {
    let seen: Pick<RunnerRequest, "sandboxMode" | "networkAccess"> | null = null;
    const runner: AgentRunner = {
      run: async (request) => {
        seen = { sandboxMode: request.sandboxMode, networkAccess: request.networkAccess };
        return { output: "ok", threadId: "t", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service } = await harness(runner);
    const agent = await service.createAgent({ name: "Sandboxed" }, OWNER);
    await service.setGuardrailPolicy(agent.id, {
      sandboxMode: "read-only",
      networkAccess: true,
      rules: [],
    });

    const { run } = await service.sendMessage(agent.id, "look around", OWNER);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(seen).toEqual({ sandboxMode: "read-only", networkAccess: false });
  });
});
