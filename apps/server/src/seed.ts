import type { User } from "./types.js";

// Mock identity table. Track scope: no production OAuth/SSO — 2-3 hardcoded
// principals are sufficient. The Identity/Policy owner may replace this with a
// real user store; the enforcement layer only depends on `User`.
export const SEED_USERS: readonly User[] = [
  { id: "user-alice", name: "Alice", role: "owner-capable" },
  { id: "user-bob", name: "Bob", role: "standard" },
  { id: "user-carol", name: "Carol", role: "standard" },
] as const;

export const DEFAULT_OWNER_ID = "user-alice";
