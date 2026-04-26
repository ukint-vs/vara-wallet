/**
 * Opt-in stage instrumentation. When the `--timing` global flag is set,
 * `markStage()` emits an NDJSON event to stderr like:
 *
 *   {"stage":"connect","ms":920}
 *   {"stage":"metadata_cache","hit":true,"ms":15}
 *   {"stage":"total","ms":1103}
 *
 * When `--timing` is absent, every export is a no-op — zero `Date.now()`
 * calls, zero stderr writes, zero parse cost. The flag is read once at
 * `enableTiming()` time (called from app.ts:preAction) so the hot path
 * is a single boolean check.
 *
 * Stays out of the existing stderr verbose-log channel (which is
 * human-readable text). Agent parsers that care about the existing
 * `--json stderr leak` contract (PR #34) only see timing events when
 * they explicitly opt in.
 */

// Captured at module load time, which is essentially process start (the
// CLI bundle imports this near the top). Used as the baseline for `total`.
const moduleLoadTime = Date.now();

let enabled = false;

/** Called once from app.ts when `--timing` is on. */
export function enableTiming(): void {
  enabled = true;
}

export function isTimingEnabled(): boolean {
  return enabled;
}

/**
 * Emit a timing event. `extra` fields are merged into the JSON.
 * `ms` field is the millis elapsed since the previous `markStage` call
 * (or process start if this is the first). Pass `total: true` to also
 * include cumulative `total_ms` since process start.
 */
let lastMark = 0;

export function markStage(stage: string, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  const now = Date.now();
  if (lastMark === 0) lastMark = moduleLoadTime;
  const event: Record<string, unknown> = {
    stage,
    ms: now - lastMark,
    ...(extra ?? {}),
  };
  lastMark = now;
  process.stderr.write(JSON.stringify(event) + '\n');
}

/** Emit a final `{"stage":"total","ms":N}` since process start. */
export function markTotal(): void {
  if (!enabled) return;
  process.stderr.write(JSON.stringify({ stage: 'total', ms: Date.now() - moduleLoadTime }) + '\n');
}
