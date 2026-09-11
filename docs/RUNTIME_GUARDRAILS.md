# Runtime guardrails — contract & wiring

The authorization layer ([POLICY_ENFORCEMENT.md](POLICY_ENFORCEMENT.md)) decides
*who may invoke an Agent*. Runtime guardrails decide *what the Agent may do once
it is running* — enforced server-side in the run path, with every non-clean
decision written to the same audit log.

## Where it runs

```
sendMessage ─▶ AgentService.executeRun
                 │  checkpoint 2 (authorization): enforce("invoke")
                 │
                 │  GUARDRAIL A — evaluatePrompt(policy, prompt, instructions)
                 │      deny ⇒ run never spawns, status "blocked"
                 │
                 │  GUARDRAIL B — resolveSandbox(policy)
                 │      picks the Codex --sandbox mode + network flag
                 │
                 ▼
             AgentRunner.run({ sandboxMode, networkAccess, onAction })
                 │  Codex --json event stream
                 │
                 │  GUARDRAIL C — onAction(event) for every command /
                 │      file change / tool call, live
                 │      deny ⇒ Codex process killed, status "blocked"
                 ▼
             result.output
                 │  GUARDRAIL D — screenOutput(policy, output)
                 │      flag ⇒ span redacted, run completes
                 │      deny ⇒ output withheld, status "blocked"
                 ▼
             stored message
```

A guardrail block is **not** a failure: the run ends `blocked`, the reason is on
`run.error`, and the Agent returns to `ready`.

## Policy model

Every Agent carries a `GuardrailPolicy` (`apps/server/src/types.ts`):

| Field | Meaning |
| --- | --- |
| `sandboxMode` | `read-only` \| `workspace-write` — the Codex sandbox for this Agent. May only **tighten** the platform ceiling (`CODEX_SANDBOX_MODE`, collapsed so `danger-full-access` → `workspace-write`). |
| `networkAccess` | Allow the run outbound network (`sandbox_workspace_write.network_access`). Forced off under `read-only`. Default `false`. |
| `rules[]` | Owner-defined `GuardrailRule`s, evaluated **after** the always-on baseline. |
| `updatedAt` | ISO timestamp of the last change. |

`GuardrailRule` = `{ id, kind, pattern, effect, message, builtin? }`

- `kind`: `prompt_pattern` \| `command_pattern` \| `path_pattern` \| `output_pattern`
- `pattern`: a JavaScript regular expression, matched case-insensitively
- `effect`: `deny` (block / kill / withhold) or `flag` (allow, but record)

**Platform baseline** (`apps/server/src/guardrail/policy-defaults.ts`,
`BASELINE_RULES`): always evaluated first, cannot be removed or loosened by an
owner. Recursive `rm` of a root/home/wildcard, `curl … | sh`, fork bombs, raw
block-device writes, credential-file reads (flag), writes into system
directories, and secret-shaped output (OpenAI / AWS keys, private-key blocks —
flag). A file change that resolves outside the Agent workspace is denied
structurally, not by pattern.

## Modes (`GUARDRAIL_MODE`)

| Mode | `deny` rule | `flag` rule |
| --- | --- | --- |
| `enforce` (default) | blocks / kills / withholds | records, allows |
| `monitor` | records with `enforced: false`, allows | records, allows |
| `off` | no evaluation | no evaluation |

## The engine surface (`apps/server/src/guardrail/engine.ts`)

```ts
GuardrailEngine.fromConfig(config)              // mode + sandbox ceiling from AppConfig
engine.evaluatePrompt(policy, prompt, instr)   // -> GuardrailDecision
engine.resolveSandbox(policy)                   // -> { sandboxMode, networkAccess }
engine.evaluateAction(policy, event, wsPath)   // -> GuardrailDecision (command / file / tool)
engine.screenOutput(policy, output)            // -> { proceed, output, redactions, matched, ... }
engine.normalizePolicyInput(input)             // validate + assign ids; throws HttpError(400)
```

`GuardrailDecision` = `{ proceed, effect: "deny"|"flag"|"none", ruleId?, reason }`.
The enforcement code audits whenever `effect !== "none"` and stops the run when
`proceed === false`.

## Audit entries

One entry per non-clean decision, via the same `AuditLogger.record()`:

| `action` | `actor.type` | `decision` | `payload.checkpoint` |
| --- | --- | --- | --- |
| `guardrail.prompt` | human | `deny` / `allow` | `guardrail-preflight` |
| `guardrail.command` · `guardrail.file_change` · `guardrail.mcp_tool_call` | agent | `deny` / `allow` | `guardrail-runtime` |
| `guardrail.output` | agent | `deny` / `allow` | `guardrail-output` |
| `policy.guardrail_update` | human | `allow` | `request` |

`payload` also carries `ruleId`, `reason`, `enforced` (bool), and a truncated
`value` (the command line, path, or match count — never the raw output).

## API

| Endpoint | Action | Body / result |
| --- | --- | --- |
| `GET /api/agents/:id/guardrail` | `view_config` | `{ policy, baseline, mode, sandboxCeiling }` |
| `PUT /api/agents/:id/guardrail` | `edit_config` | `{ sandboxMode, networkAccess, rules[] }` → `{ policy }`; 400 on a bad regex or a sandbox mode above the ceiling; 409 while a run is active |

The Agent object returned by every other route now includes `guardrailPolicy`.

## Store migration

`Database.version` is bumped to `3`. A v2 file loads with each Agent backfilled
to the default policy (`defaultGuardrailPolicy()`), then persisted once.

## Known limits (this increment)

- **Guardrail C is detect-and-halt, not pre-execution approval.** The command
  string is available at Codex's `item.started` event, but the command may
  already be executing when the deny verdict kills the process. True per-call
  approval needs integrating with Codex's approval protocol — a separate step.
- The live monitor depends on Codex's `--json` item schema
  (`command_execution` / `file_change` / `mcp_tool_call`). A Codex version that
  changes those names degrades the monitor to whatever it still recognises;
  Guardrails A, B and D are unaffected.
- `payload.value` for a command entry is not itself secret-scanned — a secret
  passed as a CLI argument could appear there (still bounded to 200 chars and
  subject to the audit redactor's key-based pass).
- Network control is the Codex sandbox flag only; there is no per-host egress
  allow-list (that is the platform ADR's Phase 4).

## Tests

- `guardrail/engine.test.ts` — baseline rules, workspace escape, prompt/output,
  sandbox tighten-only, monitor mode, policy validation.
- `guardrail-runtime.test.ts` — prompt block, live-monitor kill, output
  redaction, monitor mode, sandbox flag propagation, all through `AgentService`.
- `enforcement.test.ts` — the guardrail routes gated by `view_config` /
  `edit_config`, `policy.guardrail_update` audited, 400 on a bad regex.
- `codex-runner.test.ts` — arg building with the network flag, event
  normalisation for the monitor.
- `store.test.ts` — v2 → v3 migration.
