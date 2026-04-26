/**
 * Drain stdout/stderr before terminating. `process.exit()` does not wait
 * for pending writes on a pipe (Node docs: "force the process to exit as
 * quickly as possible even if there are still asynchronous operations
 * pending"). Without this, `vara-wallet ... | jq` can lose the last chunk
 * of output. TTY writes are synchronous so the drain is a no-op there.
 *
 * Why exit at all? @polkadot/api keeps heartbeat timers and reconnect
 * schedulers alive ~1.7s after `apiInstance.disconnect()` is called.
 * Natural Node exit waits for those handles, adding 60% to every
 * invocation's wall clock with no user-visible work happening.
 *
 * Lives in utils (not app.ts) so signal handlers and stream-shutdown
 * paths in `commands/subscribe/shared.ts` can route through the same
 * drain pattern instead of calling `process.exit()` directly.
 */
export function fastExit(code: number): void {
  const finish = (): void => process.exit(code);
  // Drain stderr first (verbose logs, --timing events). Then stdout.
  const drainStdout = (): void => {
    if (process.stdout.writableNeedDrain) {
      process.stdout.once('drain', finish);
    } else {
      finish();
    }
  };
  if (process.stderr.writableNeedDrain) {
    process.stderr.once('drain', drainStdout);
  } else {
    drainStdout();
  }
}
