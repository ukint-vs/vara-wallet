import { GearApi, type UserMessageSent } from '@gear-js/api';
import { outputNdjson, verbose, CliError, tryHexToText } from '../../utils';
import { insertEvent, type EventInsert } from '../../services/event-store';
import { disconnectApi } from '../../services/api';
import type { LoadedSails } from '../../services/sails';
import { decodeSailsEvent, resolveEventName } from '../../services/sails-events';

/**
 * Install a global timeout that fires regardless of subscription phase.
 * Must be called BEFORE getApi() to cover connection hangs.
 */
export function installGlobalTimeout(timeoutStr?: string): void {
  if (!timeoutStr) return;
  const seconds = parseInt(timeoutStr, 10);
  if (isNaN(seconds) || seconds <= 0) return;
  setTimeout(() => {
    verbose('Global timeout reached, exiting...');
    disconnectApi();
    process.exit(0);
  }, seconds * 1000);
}

// Valid IGearEvent keys
const VALID_GEAR_EVENTS = [
  'MessageQueued',
  'UserMessageSent',
  'UserMessageRead',
  'MessagesDispatched',
  'MessageWaited',
  'MessageWaken',
  'CodeChanged',
  'ProgramChanged',
  'ProgramResumeSessionStarted',
] as const;

export type GearEventName = (typeof VALID_GEAR_EVENTS)[number];

/**
 * Validate an event name against known IGearEvent keys.
 */
export function validateEventName(name: string): GearEventName {
  if (!VALID_GEAR_EVENTS.includes(name as GearEventName)) {
    throw new CliError(
      `Unknown event type "${name}". Valid types: ${VALID_GEAR_EVENTS.join(', ')}`,
      'INVALID_EVENT_TYPE',
    );
  }
  return name as GearEventName;
}

/**
 * Validate --from-block as a positive integer.
 */
export function validateFromBlock(value: string): number {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 0) {
    throw new CliError(
      `Invalid --from-block value "${value}". Must be a non-negative integer.`,
      'INVALID_FROM_BLOCK',
    );
  }
  return num;
}

/**
 * Emit a system lifecycle event via NDJSON.
 */
export function emitSystemEvent(event: string, extra?: Record<string, unknown>): void {
  outputNdjson({ type: 'system', event, timestamp: Date.now(), ...extra });
}

/**
 * Output an event via NDJSON and persist to SQLite if enabled.
 */
export function emitAndPersist(data: Record<string, unknown>, persist: boolean, eventInsert?: EventInsert): void {
  outputNdjson(data);
  if (persist && eventInsert) {
    insertEvent(eventInsert);
  }
}

/**
 * Wrap a callback in try/catch to prevent subscription death on errors.
 */
export function safeCallback<T>(fn: (event: T) => void): (event: T) => void {
  return (event: T) => {
    try {
      fn(event);
    } catch (err) {
      verbose(`Warning: Event callback error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/**
 * Install a handler that exits cleanly on EPIPE (e.g., piping to `head`).
 */
export function installEpipeHandler(): void {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
  });
}

/**
 * Create an event counter for --count support.
 */
export function createEventCounter(maxCount?: number): { increment: () => boolean } {
  let count = 0;
  return {
    /** Increment counter. Returns true if limit reached. */
    increment(): boolean {
      if (maxCount === undefined) return false;
      count++;
      return count >= maxCount;
    },
  };
}

export interface KeepAliveOptions {
  count?: number;
  timeout?: number; // seconds
}

/**
 * Keep the process alive until SIGINT/SIGTERM, count reached, or timeout.
 * Calls all unsubscribe functions on exit.
 */
export function keepAlive(
  unsubscribers: Array<() => void>,
  options?: KeepAliveOptions,
): { promise: Promise<void>; triggerExit: () => void } {
  let resolve: () => void;
  let settled = false;

  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  const cleanup = () => {
    if (settled) return;
    settled = true;
    for (const unsub of unsubscribers) {
      try {
        unsub();
      } catch {
        // Ignore unsubscribe errors
      }
    }
    disconnectApi();
    resolve!();
  };

  // Override default signal handlers from app.ts
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Timeout support
  if (options?.timeout) {
    setTimeout(cleanup, options.timeout * 1000);
  }

  return { promise, triggerExit: cleanup };
}

const RECONNECT_DEBOUNCE_MS = 5000;
const RECONNECT_MAX_RETRIES = 3;

/**
 * Wrap a subscription with auto-reconnect on WebSocket disconnect.
 * No-op for light client mode (smoldot doesn't reconnect).
 */
export async function withReconnect(
  api: GearApi,
  subscribeFn: () => Promise<() => void>,
): Promise<() => void> {
  const isLightClient = process.env.VARA_LIGHT === '1';

  let currentUnsub = await subscribeFn();

  if (isLightClient) {
    return currentUnsub;
  }

  let lastReconnect = 0;

  api.on('connected', () => {
    const now = Date.now();
    if (now - lastReconnect < RECONNECT_DEBOUNCE_MS) {
      verbose('Reconnect debounced (too rapid)');
      return;
    }
    lastReconnect = now;

    emitSystemEvent('reconnected');
    verbose('WebSocket reconnected, re-subscribing...');

    // Re-subscribe with retries
    let retries = 0;
    const resubscribe = async () => {
      try {
        // Unsub old subscription
        try {
          currentUnsub();
        } catch {
          // Ignore
        }
        currentUnsub = await subscribeFn();
        verbose('Re-subscribed successfully');
      } catch (err) {
        retries++;
        if (retries < RECONNECT_MAX_RETRIES) {
          verbose(`Re-subscribe attempt ${retries} failed, retrying in ${retries * 2}s...`);
          setTimeout(resubscribe, retries * 2000);
        } else {
          emitSystemEvent('resubscribe_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          verbose('Re-subscribe failed after max retries');
        }
      }
    };

    resubscribe();
  });

  api.on('disconnected', () => {
    emitSystemEvent('disconnected');
    verbose('WebSocket disconnected');
  });

  return currentUnsub;
}

/**
 * Extract fields from a UserMessageSent event.
 */
export function formatUserMessageSent(event: UserMessageSent): Record<string, unknown> {
  const { message } = event.data;
  const payloadHex = message.payload.toHex();
  const payloadAscii = tryHexToText(payloadHex);
  return {
    messageId: message.id.toHex(),
    source: message.source.toHex(),
    destination: message.destination.toHex(),
    payload: payloadHex,
    ...(payloadAscii !== undefined && { payloadAscii }),
    value: message.value.toString(),
    details: message.details.isSome
      ? {
          replyTo: message.details.unwrap().to.toHex(),
          code: message.details.unwrap().code.toString(),
        }
      : null,
  };
}

/**
 * Typed shape of the decoded NDJSON augmentation block. The `kind`
 * discriminator is a literal so consumers can switch on it; future
 * decoder types (e.g. EVM events) sit alongside `'sails'`.
 */
export type DecodedBlock = {
  kind: 'sails';
  service: string;
  event: string;
  data: unknown;
};

/**
 * Decode a `UserMessageSent` against an optional Sails IDL and return the
 * existing raw shape, additively augmented with
 * `decoded: { kind: 'sails', service, event, data }` when a decode
 * succeeds. NEVER renames or removes existing raw fields.
 *
 * The `kind: 'sails'` discriminator future-proofs the surface so a second
 * decoder type (e.g. EVM events) can sit alongside without renaming the
 * top-level field again. Replaces the 0.14.x `sails: {...}` shape.
 *
 * `sails-js`'s own `events[E].is()` only checks destination + payload
 * prefix. So we MUST pre-filter by `message.source === programIdHex`
 * here; otherwise an unrelated program that happens to share the
 * service hash + event id would get its events spuriously decoded
 * against this IDL.
 */
export function formatUserMessageSentMaybeDecoded(
  event: UserMessageSent,
  sails: LoadedSails | null,
  programIdHex: string,
): Record<string, unknown> {
  const raw = formatUserMessageSent(event);
  if (!sails) return raw;
  const sourceHex = event.data.message.source.toHex();
  if (sourceHex !== programIdHex) return raw;
  const decoded = decodeSailsEvent(sails, event);
  if (!decoded) return raw;
  const decodedBlock: DecodedBlock = {
    kind: 'sails',
    service: decoded.service,
    event: decoded.event,
    data: decoded.data,
  };
  return { ...raw, decoded: decodedBlock };
}

/**
 * Returns true when the formatted message has a Sails-decoded block
 * matching the given filter. Used by both `watch` and
 * `subscribe messages` to decide whether to emit a UserMessageSent
 * event after the IDL-aware filter is set.
 */
export function matchesSailsFilter(
  formatted: Record<string, unknown>,
  filter: { service: string; event: string },
): boolean {
  const block = (formatted as { decoded?: DecodedBlock }).decoded;
  return (
    block !== undefined &&
    block.kind === 'sails' &&
    block.service === filter.service &&
    block.event === filter.event
  );
}

/**
 * Resolved filter for the `--event` flag on watch / subscribe messages.
 *
 * `pallet` — match a `gearEvents` pallet event by name.
 * `sails` — match a Sails IDL event by `(service, event)`.
 *
 * Resolution order:
 *   1. `pallet:` prefix → strip and resolve as pallet event (forces pallet
 *      vocab even when an IDL is loaded). Replaces the old `--pallet-event`
 *      flag with a single-flag mental model.
 *   2. Bare names that match the legacy Gear vocab → pallet path
 *      (back-compat: existing scripts using `--event UserMessageSent`
 *      keep working).
 *   3. Sails IDL lookup if an IDL is loaded — bare names that match a
 *      Sails event resolve to the sails path. `Service/Event` is always
 *      unambiguous.
 *   4. Falls back to pallet validation, which surfaces a clean error if
 *      the name doesn't match anywhere.
 *
 * Ambiguous bare Sails names (same name in multiple services) hard-fail
 * with `AMBIGUOUS_EVENT` listing the alternatives — `resolveEventName`
 * throws that and we let it propagate.
 */
export type ResolvedSubscribeFilter =
  | { kind: 'sails'; service: string; event: string }
  | { kind: 'pallet'; event: GearEventName };

/** `pallet:Foo` → forces pallet vocab. Replaces the dropped `--pallet-event` flag. */
export const PALLET_PREFIX = 'pallet:';

export function resolveSubscribeFilter(
  name: string,
  sails: LoadedSails | null,
): ResolvedSubscribeFilter {
  // `pallet:` prefix forces pallet vocab regardless of IDL state.
  if (name.startsWith(PALLET_PREFIX)) {
    return { kind: 'pallet', event: validateEventName(name.slice(PALLET_PREFIX.length)) };
  }
  // Gear-first precedence — bare names that match the legacy pallet vocab
  // always resolve to the pallet path. Anything else would silently break
  // existing scripts when an IDL happens to declare a same-named event.
  if (!name.includes('/') && (VALID_GEAR_EVENTS as readonly string[]).includes(name)) {
    return { kind: 'pallet', event: name as GearEventName };
  }
  if (sails) {
    // resolveEventName throws AMBIGUOUS_EVENT on multi-service bare-name
    // matches — surface that to the user untouched.
    const match = resolveEventName(sails, name);
    if (match) return { kind: 'sails', service: match.service, event: match.event };
  }
  // Fall back to pallet validation (back-compat error path).
  return { kind: 'pallet', event: validateEventName(name) };
}

/**
 * Parse a duration string like "1h", "30m", "7d" into milliseconds.
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    throw new CliError(
      `Invalid duration "${duration}". Use format like: 30s, 5m, 1h, 7d`,
      'INVALID_DURATION',
    );
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * multipliers[unit];
}
