import {
  AI_MANAGEMENT_UPSTREAM_SINGLE_CALL_MS,
  AI_MANAGEMENT_UPSTREAM_TOTAL_MS,
} from "../../shared/ai"

/**
 * Per-request budget for owner-facing AI management operations.
 *
 * One stage (authorization start, poll, or model refresh) shares an absolute
 * deadline from request arrival and a combined upstream HTTP budget. Each
 * upstream call is capped by the single-call limit, by what remains of the
 * combined upstream budget, and by what remains of the stage deadline —
 * whichever is smallest. Elapsed time is measured against the wall clock so a
 * call that consumed its own timeout also consumes the shared budget; the
 * logical `now` values used for D1 state remain caller-provided and never
 * interact with this accounting.
 *
 * The stage deadline is never reset when switching phases, recovering from a
 * 401, or retrying.
 */
export class AiStageUpstreamBudget {
  private remainingUpstreamMs: number
  private readonly deadlineAt: number

  constructor(input: {
    deadlineAt: number
    /** Override for the combined upstream budget; tests use it to model exhaustion. */
    upstreamTotalMs?: number
  }) {
    this.remainingUpstreamMs = Math.max(
      0,
      input.upstreamTotalMs ?? AI_MANAGEMENT_UPSTREAM_TOTAL_MS,
    )
    this.deadlineAt = input.deadlineAt
  }

  /** The allowed duration for the next single upstream call; 0 means exhausted. */
  nextSingleCallMs(): number {
    const remainingStageMs = this.deadlineAt - Date.now()
    return Math.max(
      0,
      Math.min(
        AI_MANAGEMENT_UPSTREAM_SINGLE_CALL_MS,
        this.remainingUpstreamMs,
        remainingStageMs,
      ),
    )
  }

  /** Records the wall-clock time one upstream call actually consumed. */
  recordElapsedMs(elapsedMs: number): void {
    this.remainingUpstreamMs = Math.max(
      0,
      this.remainingUpstreamMs - Math.max(0, elapsedMs),
    )
  }

  /**
   * Runs one upstream call inside the budget. `budget-exhausted` is returned
   * before the operation is invoked, which is what makes a skipped refresh
   * provably-not-sent.
   */
  async withinBudget<T>(
    operation: (options: { timeoutMs: number }) => Promise<T>,
  ): Promise<
    { ok: true; value: T } | { ok: false; reason: "budget-exhausted" }
  > {
    const timeoutMs = this.nextSingleCallMs()
    if (timeoutMs === 0) return { ok: false, reason: "budget-exhausted" }
    const startedAt = Date.now()
    try {
      return { ok: true, value: await operation({ timeoutMs }) }
    } finally {
      this.recordElapsedMs(Date.now() - startedAt)
    }
  }
}
