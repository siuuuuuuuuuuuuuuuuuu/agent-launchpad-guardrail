import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  // Runtime guardrails: "enforce" blocks on deny rules, "monitor" only audits,
  // "off" disables evaluation entirely.
  GUARDRAIL_MODE: z.enum(["enforce", "monitor", "off"]).default("enforce"),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Identity. "local" is the mock X-User-Id + seeded-user path (unchanged
  // default). "oidc" verifies real sessions against a standards-compliant
  // identity provider (WorkOS, Okta, Entra, Auth0, Keycloak, ...) via
  // Authorization Code + PKCE and OIDC discovery — see docs/IDENTITY.md.
  AUTH_MODE: z.enum(["local", "oidc"]).default("local"),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().trim().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().trim().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_SCOPES: z.string().trim().min(1).default("openid profile email"),
  // Comma-separated allowlist: a verified email in this list is provisioned
  // owner-capable. Everyone else provisions standard. Placeholder for real
  // role/group sync (SCIM) — see docs/IDENTITY.md limitations.
  OIDC_ADMIN_EMAILS: z.string().trim().optional(),
  // Signs the app's own short-lived session token minted after the OIDC
  // callback. Required (24+ chars) whenever AUTH_MODE=oidc.
  SESSION_SECRET: z.string().trim().optional(),
  SESSION_TTL_MS: z.coerce.number().int().min(60_000).default(12 * 60 * 60 * 1000),
  // Where the browser lands after a successful login. Defaults to same-origin
  // ("/"), which is correct for the production single-origin deployment;
  // override for `npm run dev` where the web app is on a different port.
  WEB_ORIGIN: z.string().url().optional(),
});

export type AppConfig = ReturnType<typeof loadConfig>;
/** Non-null only when `authMode === "oidc"`. */
export type OidcConfig = NonNullable<AppConfig["oidc"]>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  if (env.AUTH_MODE === "oidc") {
    const missing = (
      [
        ["OIDC_ISSUER", env.OIDC_ISSUER],
        ["OIDC_CLIENT_ID", env.OIDC_CLIENT_ID],
        ["OIDC_CLIENT_SECRET", env.OIDC_CLIENT_SECRET],
        ["OIDC_REDIRECT_URI", env.OIDC_REDIRECT_URI],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error("AUTH_MODE=oidc requires " + missing.join(", "));
    }
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 24) {
      throw new Error("AUTH_MODE=oidc requires SESSION_SECRET of at least 24 characters");
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    guardrailMode: env.GUARDRAIL_MODE,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
    authMode: env.AUTH_MODE,
    oidc:
      env.AUTH_MODE === "oidc"
        ? {
            issuer: env.OIDC_ISSUER!.replace(/\/+$/, ""),
            clientId: env.OIDC_CLIENT_ID!,
            clientSecret: env.OIDC_CLIENT_SECRET!,
            redirectUri: env.OIDC_REDIRECT_URI!,
            scopes: env.OIDC_SCOPES,
            adminEmails: new Set(
              (env.OIDC_ADMIN_EMAILS ?? "")
                .split(",")
                .map((email) => email.trim().toLowerCase())
                .filter(Boolean),
            ),
            sessionSecret: env.SESSION_SECRET!,
            sessionTtlMs: env.SESSION_TTL_MS,
          }
        : null,
    webOrigin: env.WEB_ORIGIN?.replace(/\/+$/, "") ?? "",
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
