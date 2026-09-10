import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates a v2 store: backfills a guardrail policy and bumps the version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-migrate-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        users: [{ id: "user-alice", name: "Alice", role: "owner-capable" }],
        agents: [
          {
            id: "agent-1",
            name: "Legacy",
            description: "",
            instructions: "",
            ownerId: "user-alice",
            status: "ready",
            workspacePath: "/tmp/agent-1",
            codexThreadId: null,
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [],
        grants: [],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();

    const agent = store.snapshot().agents[0];
    expect(agent?.guardrailPolicy).toEqual({
      sandboxMode: "workspace-write",
      networkAccess: false,
      rules: [],
      updatedAt: expect.any(String),
    });

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.version).toBe(3);
    expect(persisted.agents[0].guardrailPolicy.sandboxMode).toBe("workspace-write");
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    const failingPath = path.join(root, "db-directory");
    await mkdir(failingPath, { recursive: true });
    mutableStore.filePath = failingPath;
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
