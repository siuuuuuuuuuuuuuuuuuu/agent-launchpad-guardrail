import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import type {
  GuardrailEffect,
  GuardrailPolicy,
  GuardrailRule,
  GuardrailRuleKind,
  GuardrailSandboxMode,
  RuntimeActionEvent,
} from "../types.js";
import { BASELINE_RULES, defaultGuardrailPolicy } from "./policy-defaults.js";

// ---------------------------------------------------------------------------
// Runtime guardrail engine.
//
// One object, consulted at four points in the run path (see AgentService):
//   - evaluatePrompt   before Codex is spawned
//   - resolveSandbox   while assembling the Codex argv
//   - evaluateAction   for each command / file change / tool call, live
//   - screenOutput     on the final agent message, before it is stored
//
// Mode:
//   enforce  deny rules block; flag rules are recorded
//   monitor  nothing is blocked; every match is recorded (with enforced:false)
//   off      no evaluation at all
// ---------------------------------------------------------------------------

export type GuardrailMode = "enforce" | "monitor" | "off";

const SANDBOX_RANK: Record<GuardrailSandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
};

export interface GuardrailDecision {
  /** Does the run proceed? `false` only for a deny rule while enforcing. */
  proceed: boolean;
  /** The matched rule's effect, or `"none"` when nothing matched. */
  effect: GuardrailEffect | "none";
  ruleId?: string;
  reason: string;
}

const CLEAN: GuardrailDecision = { proceed: true, effect: "none", reason: "no rule matched" };

export interface OutputScreenResult {
  /** `false` when a deny `output_pattern` matched while enforcing. */
  proceed: boolean;
  /** The output with every `flag` match masked. Equal to the input when clean. */
  output: string;
  redactions: number;
  matched: { ruleId: string; effect: GuardrailEffect }[];
  reason: string;
}

export interface GuardrailEngineOptions {
  mode?: GuardrailMode;
  /** An Agent policy may tighten below this, never above it. */
  sandboxCeiling?: GuardrailSandboxMode;
}

export class GuardrailEngine {
  readonly mode: GuardrailMode;
  readonly sandboxCeiling: GuardrailSandboxMode;

  constructor(options: GuardrailEngineOptions = {}) {
    this.mode = options.mode ?? "enforce";
    this.sandboxCeiling = options.sandboxCeiling ?? "workspace-write";
  }

  static fromConfig(config: AppConfig): GuardrailEngine {
    return new GuardrailEngine({
      mode: config.guardrailMode,
      // `danger-full-access` is never offered per-Agent; it collapses to the
      // strongest per-Agent option.
      sandboxCeiling:
        config.codexSandboxMode === "read-only" ? "read-only" : "workspace-write",
    });
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  get enforcing(): boolean {
    return this.mode === "enforce";
  }

  /** Baseline rules first, then the Agent's own — the order matters for `flag` vs `deny`. */
  private rulesFor(policy: GuardrailPolicy, kind: GuardrailRuleKind): GuardrailRule[] {
    return [...BASELINE_RULES, ...policy.rules].filter((rule) => rule.kind === kind);
  }

  private firstMatch(value: string, rules: GuardrailRule[]): GuardrailDecision {
    for (const rule of rules) {
      const expression = compile(rule.pattern, "i");
      if (!expression || !expression.test(value)) continue;
      const blocked = rule.effect === "deny" && this.enforcing;
      return {
        proceed: !blocked,
        effect: rule.effect,
        ruleId: rule.id,
        reason: rule.message,
      };
    }
    return CLEAN;
  }

  evaluatePrompt(
    policy: GuardrailPolicy,
    prompt: string,
    instructions = "",
  ): GuardrailDecision {
    if (!this.enabled) return CLEAN;
    return this.firstMatch(
      [prompt, instructions].filter(Boolean).join("\n"),
      this.rulesFor(policy, "prompt_pattern"),
    );
  }

  /** The sandbox mode + network flag actually handed to Codex for this Agent. */
  resolveSandbox(policy: GuardrailPolicy): {
    sandboxMode: GuardrailSandboxMode;
    networkAccess: boolean;
  } {
    const requested: GuardrailSandboxMode =
      policy.sandboxMode === "read-only" ? "read-only" : "workspace-write";
    const sandboxMode =
      SANDBOX_RANK[requested] <= SANDBOX_RANK[this.sandboxCeiling]
        ? requested
        : this.sandboxCeiling;
    return {
      sandboxMode,
      networkAccess: sandboxMode === "workspace-write" && policy.networkAccess === true,
    };
  }

  /** Evaluate one live agent action (command, file change, tool call). */
  evaluateAction(
    policy: GuardrailPolicy,
    event: RuntimeActionEvent,
    workspacePath?: string,
  ): GuardrailDecision {
    if (!this.enabled) return CLEAN;

    if (event.kind === "file_change") {
      const escape = this.workspaceEscape(event.value, workspacePath);
      if (escape) return escape;
      return this.firstMatch(event.value, this.rulesFor(policy, "path_pattern"));
    }

    // command + mcp_tool_call are both matched against command_pattern rules.
    return this.firstMatch(event.value, this.rulesFor(policy, "command_pattern"));
  }

  private workspaceEscape(
    changedPath: string,
    workspacePath: string | undefined,
  ): GuardrailDecision | null {
    if (!workspacePath) return null;
    const resolved = path.resolve(workspacePath, changedPath);
    const relative = path.relative(workspacePath, resolved);
    const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    if (inside) return null;
    return {
      proceed: !this.enforcing,
      effect: "deny",
      ruleId: "baseline.workspace-escape",
      reason: "File change outside the Agent workspace: " + changedPath,
    };
  }

  /** Screen the final agent message. `flag` masks; `deny` blocks the whole output. */
  screenOutput(policy: GuardrailPolicy, output: string): OutputScreenResult {
    if (!this.enabled || !output) {
      return { proceed: true, output, redactions: 0, matched: [], reason: "not screened" };
    }
    const rules = this.rulesFor(policy, "output_pattern");
    const matched: { ruleId: string; effect: GuardrailEffect }[] = [];

    for (const rule of rules) {
      if (rule.effect !== "deny") continue;
      const expression = compile(rule.pattern, "i");
      if (expression?.test(output) && this.enforcing) {
        return {
          proceed: false,
          output,
          redactions: 0,
          matched: [{ ruleId: rule.id, effect: "deny" }],
          reason: rule.message,
        };
      }
    }

    let screened = output;
    let redactions = 0;
    for (const rule of rules) {
      const expression = compile(rule.pattern, "gi");
      if (!expression) continue;
      screened = screened.replace(expression, () => {
        redactions += 1;
        return "[REDACTED:" + rule.id + "]";
      });
      if (redactions > 0 && !matched.some((m) => m.ruleId === rule.id)) {
        matched.push({ ruleId: rule.id, effect: rule.effect });
      }
    }

    return {
      proceed: true,
      output: screened,
      redactions,
      matched,
      reason: redactions > 0 ? "output redacted" : "clean",
    };
  }

  /**
   * Validate and normalise an owner-submitted policy. Throws `HttpError` (400)
   * on a bad regex or a sandbox mode above the ceiling. Baseline rules are
   * never stored — the engine always prepends them — so the input carries only
   * the owner's own rules.
   */
  normalizePolicyInput(input: {
    sandboxMode: GuardrailSandboxMode;
    networkAccess: boolean;
    rules: { kind: GuardrailRuleKind; pattern: string; effect: GuardrailEffect; message: string }[];
  }): GuardrailPolicy {
    if (SANDBOX_RANK[input.sandboxMode] > SANDBOX_RANK[this.sandboxCeiling]) {
      throw new HttpError(
        400,
        "sandboxMode '" + input.sandboxMode + "' exceeds the platform ceiling '" +
          this.sandboxCeiling + "'",
      );
    }
    const rules: GuardrailRule[] = input.rules.map((rule, index) => {
      if (!compile(rule.pattern, "i")) {
        throw new HttpError(400, "rules[" + index + "]: '" + rule.pattern + "' is not a valid regular expression");
      }
      if (rule.pattern.length > 512) {
        throw new HttpError(400, "rules[" + index + "]: pattern is too long (max 512 chars)");
      }
      return {
        id: "rule." + rule.kind + "." + randomUUID().slice(0, 8),
        kind: rule.kind,
        pattern: rule.pattern,
        effect: rule.effect,
        message: rule.message.trim() || "Matched a custom guardrail rule",
        builtin: false,
      };
    });
    if (rules.length > 100) {
      throw new HttpError(400, "a policy may hold at most 100 rules");
    }
    return {
      sandboxMode: input.sandboxMode,
      networkAccess: input.networkAccess === true,
      rules,
      updatedAt: new Date().toISOString(),
    };
  }
}

/** The baseline rules, exposed so the UI can show what always applies. */
export function baselineRules(): GuardrailRule[] {
  return BASELINE_RULES.map((rule) => ({ ...rule }));
}

export { defaultGuardrailPolicy };

const compileCache = new Map<string, RegExp | null>();

function compile(pattern: string, flags: string): RegExp | null {
  const key = flags + " " + pattern;
  const cached = compileCache.get(key);
  if (cached !== undefined) return cached;
  let expression: RegExp | null = null;
  try {
    expression = new RegExp(pattern, flags);
  } catch {
    expression = null;
  }
  if (compileCache.size > 500) compileCache.clear();
  compileCache.set(key, expression);
  return expression;
}
