import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { AuditLogger } from "./logger.js";
import { JsonlAuditStore } from "./store/JsonlAuditStore.js";
import { createAuditRoutes } from "./routes.js";

// runs the actual demo script through the real store + real http route,
// not mocks - if this fails, the demo's audit log beat won't work either.
describe("demo scenario: create, deny, grant, allow, revoke, deny again", () => {
  let dir: string;
  let store: JsonlAuditStore;
  let logger: AuditLogger;
  let app: ReturnType<typeof Fastify>;
  const filePath = () => join(dir, "audit.jsonl");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "audit-log-demo-"));
    store = new JsonlAuditStore(filePath());
    logger = new AuditLogger(store);
    app = Fastify();
    await app.register(createAuditRoutes(store));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces the right trail and doesn't leak the secret in the payload", async () => {
    const AGENT = "agent-1";

    // user A creates the agent
    await logger.record({
      actor: { id: "user-a" },
      action: "create",
      target: { type: "agent", id: AGENT },
      decision: "allow",
    });

    // user B tries before any grant exists - denied
    await logger.record({
      actor: { id: "user-b" },
      action: "invoke",
      target: { type: "agent", id: AGENT },
      decision: "deny",
      payload: { reason: "no grant for user-b on agent-1" },
    });

    // user A grants invoke-only. sneaking a fake secret in here to check redaction.
    await logger.record({
      actor: { id: "user-a" },
      action: "grant",
      target: { type: "grant", id: "grant-1" },
      decision: "allow",
      payload: { scopes: ["invoke"], grantedTo: "user-b", arkKey: "sk-should-never-hit-disk" },
    });

    // user B invokes - allowed now
    await logger.record({
      actor: { id: "user-b" },
      action: "invoke",
      target: { type: "agent", id: AGENT },
      decision: "allow",
    });

    // user B tries to delete - outside their scope, denied
    await logger.record({
      actor: { id: "user-b" },
      action: "delete",
      target: { type: "agent", id: AGENT },
      decision: "deny",
      payload: { reason: "missing scope: delete" },
    });

    // user A revokes
    await logger.record({
      actor: { id: "user-a" },
      action: "revoke",
      target: { type: "grant", id: "grant-1" },
      decision: "allow",
    });

    // user B tries again - denied even though it worked a second ago
    await logger.record({
      actor: { id: "user-b" },
      action: "invoke",
      target: { type: "agent", id: AGENT },
      decision: "deny",
      payload: { reason: "grant revoked" },
    });

    // user A can still use their own agent the whole time
    await logger.record({
      actor: { id: "user-a" },
      action: "invoke",
      target: { type: "agent", id: AGENT },
      decision: "allow",
    });

    // now check what the log view would actually render
    const res = await app.inject({ method: "GET", url: "/api/audit?limit=200" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: any[]; nextCursor: string | null };

    expect(body.entries).toHaveLength(8);

    const sequence = body.entries.map((e) => `${e.actor.id}:${e.action}:${e.decision}`).reverse();
    expect(sequence).toEqual([
      "user-a:create:allow",
      "user-b:invoke:deny",
      "user-a:grant:allow",
      "user-b:invoke:allow",
      "user-b:delete:deny",
      "user-a:revoke:allow",
      "user-b:invoke:deny",
      "user-a:invoke:allow",
    ]);

    // every row has actor/action/decision/target/timestamp for the view
    for (const entry of body.entries) {
      expect(entry.actor?.id).toBeTruthy();
      expect(entry.action).toBeTruthy();
      expect(entry.decision).toMatch(/^(allow|deny)$/);
      expect(entry.target?.id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
    }

    // filtering the way the frontend would - just this agent's activity
    const agentOnly = await app.inject({ method: "GET", url: `/api/audit?target=${AGENT}` });
    expect(agentOnly.json().entries).toHaveLength(6); // excludes the grant/revoke rows (target=grant-1)

    // just the denials, since that's the interesting part of the demo
    const deniesOnly = await app.inject({ method: "GET", url: "/api/audit?decision=deny" });
    expect(deniesOnly.json().entries).toHaveLength(3);

    // secret should be redacted in the response and never touch disk
    const grantEntry = body.entries.find((e: any) => e.action === "grant");
    expect(grantEntry.payload.arkKey).toBe("[REDACTED]");
    expect(JSON.stringify(body)).not.toContain("sk-should-never-hit-disk");

    const rawFileContents = readFileSync(filePath(), "utf8");
    expect(rawFileContents).not.toContain("sk-should-never-hit-disk");
  });
});
