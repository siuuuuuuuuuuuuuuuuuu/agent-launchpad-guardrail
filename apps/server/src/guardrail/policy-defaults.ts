import type { GuardrailPolicy, GuardrailRule } from "../types.js";

// ---------------------------------------------------------------------------
// Platform baseline.
//
// These rules are evaluated for EVERY Agent, before any owner-defined rule,
// and an owner can neither remove them nor loosen them. Keep the list short
// and conservative: a false positive here blocks that action on every Agent on
// the platform. Owners tighten further with their own rules; they never get
// below this floor.
// ---------------------------------------------------------------------------

export const BASELINE_RULES: readonly GuardrailRule[] = [
  {
    id: "baseline.destructive-recursive-delete",
    kind: "command_pattern",
    pattern:
      "\\brm\\b[^|&;\\n]*\\s-[a-z]*r[a-z]*\\b[^|&;\\n]*\\s(?:/|~|\\$HOME|\\*|\\.\\s*$|\\.\\.)",
    effect: "deny",
    message: "Recursive delete targeting a root, home, parent, or wildcard path",
    builtin: true,
  },
  {
    id: "baseline.pipe-download-to-shell",
    kind: "command_pattern",
    pattern:
      "\\b(?:curl|wget|fetch)\\b[^|]*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|ksh|python[0-9.]*|node|perl|ruby)\\b",
    effect: "deny",
    message: "Piping a network download straight into an interpreter",
    builtin: true,
  },
  {
    id: "baseline.fork-bomb",
    kind: "command_pattern",
    pattern: ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:",
    effect: "deny",
    message: "Fork bomb",
    builtin: true,
  },
  {
    id: "baseline.raw-block-device-write",
    kind: "command_pattern",
    pattern: "\\b(?:mkfs\\S*|dd)\\b[^|&;\\n]*\\bof=/dev/|>\\s*/dev/(?:sd|nvme|disk|vd|hd)",
    effect: "deny",
    message: "Raw write to a block device",
    builtin: true,
  },
  {
    id: "baseline.credential-file-access",
    kind: "command_pattern",
    pattern:
      "\\b(?:cat|less|more|head|tail|cp|mv|scp|rsync|curl|tar|zip|base64|xxd|strings)\\b[^|&;\\n]*(?:/\\.ssh/|/\\.aws/|/\\.config/gcloud/|\\bid_rsa\\b|\\bid_ed25519\\b|/etc/shadow|\\.env(?:\\.[a-z]+)?\\b|\\.netrc\\b|\\.pgpass\\b)",
    effect: "flag",
    message: "Command reads or copies a well-known credential file",
    builtin: true,
  },
  {
    id: "baseline.system-path-write",
    kind: "path_pattern",
    pattern: "^(?:/etc/|/usr/|/bin/|/sbin/|/lib/|/root/|/boot/|/sys/|/proc/|/var/(?!folders/|tmp/))",
    effect: "deny",
    message: "File change in a system directory",
    builtin: true,
  },
  {
    id: "baseline.output-openai-key",
    kind: "output_pattern",
    pattern: "\\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}",
    effect: "flag",
    message: "Output contains an OpenAI-style secret key",
    builtin: true,
  },
  {
    id: "baseline.output-aws-key",
    kind: "output_pattern",
    pattern: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
    effect: "flag",
    message: "Output contains an AWS access key id",
    builtin: true,
  },
  {
    id: "baseline.output-private-key",
    kind: "output_pattern",
    pattern: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----",
    effect: "flag",
    message: "Output contains a private key block",
    builtin: true,
  },
];

/** The policy every Agent starts with (and v2 stores migrate to). */
export function defaultGuardrailPolicy(
  updatedAt: string = new Date().toISOString(),
): GuardrailPolicy {
  return {
    sandboxMode: "workspace-write",
    networkAccess: false,
    rules: [],
    updatedAt,
  };
}
