export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

/**
 * A runtime guardrail refused the run — a blocked prompt, a denied command or
 * file change caught by the live monitor, or blocked output. Distinct from a
 * failure: the Agent did nothing wrong, policy stopped it. The run ends
 * `blocked` and the Agent returns to `ready`.
 */
export class GuardrailError extends Error {
  constructor(
    message: string,
    public readonly ruleId?: string,
  ) {
    super(message);
    this.name = "GuardrailError";
  }
}
