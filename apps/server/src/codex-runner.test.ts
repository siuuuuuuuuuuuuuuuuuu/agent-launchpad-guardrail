import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  parseCodexEventLine,
  toRuntimeActionEvents,
} from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation with the network flag pinned off", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "build a calculator",
    ]);
  });

  it("honours a per-run sandbox mode and network grant from the request", () => {
    const readOnly = buildCodexArgs(
      {
        agentId: "a",
        workspacePath: "/w",
        prompt: "look around",
        threadId: null,
        sandboxMode: "read-only",
      },
      "workspace-write",
    );
    expect(readOnly).toContain("read-only");
    // read-only takes no network config key
    expect(readOnly).not.toContain("-c");

    const networked = buildCodexArgs(
      {
        agentId: "a",
        workspacePath: "/w",
        prompt: "fetch a package",
        threadId: null,
        sandboxMode: "workspace-write",
        networkAccess: true,
      },
      "workspace-write",
    );
    expect(networked).toContain("sandbox_workspace_write.network_access=true");
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("normalises command, file-change and tool-call items for the guardrail monitor", () => {
    expect(
      toRuntimeActionEvents({
        type: "item.started",
        item: { type: "command_execution", command: "rm -rf /", cwd: "/w" },
      }),
    ).toEqual([{ kind: "command", value: "rm -rf /", phase: "started" }]);

    expect(
      toRuntimeActionEvents({
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [{ path: "src/a.ts", kind: "update" }, { path: "/etc/hosts", kind: "add" }],
        },
      }),
    ).toEqual([
      { kind: "file_change", value: "src/a.ts", phase: "completed" },
      { kind: "file_change", value: "/etc/hosts", phase: "completed" },
    ]);

    expect(
      toRuntimeActionEvents({
        type: "item.started",
        item: { type: "mcp_tool_call", server: "fs", tool: "write" },
      }),
    ).toEqual([{ kind: "mcp_tool_call", value: "fs/write", phase: "started" }]);

    expect(toRuntimeActionEvents({ type: "turn.completed", usage: {} })).toEqual([]);
  });

  it("passes normalised actions to the parseCodexEventLine hook", () => {
    const seen: unknown[] = [];
    parseCodexEventLine(
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "git push" },
      }),
      { messages: [], threadId: null, usage: null, errors: [] },
      (event) => seen.push(event),
    );
    expect(seen).toEqual([{ kind: "command", value: "git push", phase: "started" }]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});
