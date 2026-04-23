# Phase 1 mega-PR — IDL-aware Sails event decoding

Closes #36 (decoded events in `watch`/`subscribe`), #37 (decoded events in `call` reply).
Issue #32 (recursive decode of Option/U256) shipped in PR #40 already and is wired into `call.ts`. This branch reuses that walker by adding a thin `decodeEventData` entry point.

Baseline: `main` at `ed32084`; `npm test` = **446 passing**.

## /autoplan critique applied

Codex found 8 substantive issues against the v1 plan. All addressed below. Summary of changes:

| # | Severity | Issue | Resolution |
|---|----------|-------|------------|
| 1 | HIGH | `call.ts` block-event scoping ignores extrinsic phase → cross-tx event bleed | Filter by phase index of OUR extrinsic, plus `api.events.gear.UserMessageSent.is(...)` typed check |
| 2 | HIGH | Sails `events[E].is()` checks destination=ZERO but NOT source=programId | All event-decoding paths must pre-filter `message.source === programIdHex` before `is()` |
| 3 | MED | `--idl` gating is too narrow; `loadSailsAuto` resolves chain IDLs | Auto-attempt `loadSailsAuto` in watch/subscribe when programId is given; opt-out via `--no-decode` |
| 4 | MED | API contract was self-contradictory on ambiguous bare names | Hard-fail on ambiguous bare Sails name; print `Service/Event` alternatives |
| 5 | MED | Sails-first precedence breaks back-compat + `MessageWaken` typo | Gear-first precedence; bare names resolve to Gear pallet first; Sails requires `Service/Event` form OR new `--sails-event` flag |
| 6 | MED | Output shape: reusing `event` for Sails name + adding `rawPayload` collides with raw schema | Namespace decoded data as `sails: {service, event, data}`; keep raw schema (event, payload, source, …) untouched |
| 7 | MED | `listEventNames` ignores v2 `service.extends` | Walk `service.extends` recursively |
| 8 | LOW | 12 tests insufficient | Add 5 more (cross-extrinsic block, ambiguous name, Gear-vs-Sails precedence, extends, persistence-shape stability); target +17 → 463 total |

Pre-existing bug noted but **out of scope**: `MessageWaken` should be `MessageWoken` per `IGearEvent` typings (`shared.ts:31`). The current vocab still works at runtime because `subscribeToGearEvent` accepts arbitrary keys, but the typing is wrong. Filing as separate issue, not fixing here — touching `VALID_GEAR_EVENTS` belongs in a back-compat audit, not this PR.

## Files

### NEW

1. **`src/services/sails-events.ts`**

   ```ts
   import type { UserMessageSent, HexString } from '@gear-js/api';
   import type { LoadedSails } from './sails';
   import { CliError } from '../utils';
   import { decodeEventData } from '../utils/decode-sails-result';

   export interface DecodedSailsEvent {
     service: string;
     event: string;
     data: unknown;
   }

   /** Try to decode a UserMessageSent into a typed Sails event. Caller MUST
    *  pre-filter by message.source — sails-js .is() only checks destination
    *  and the payload prefix, NOT the source program. Returns null when no
    *  service/event in this IDL recognizes the payload. */
   export function decodeSailsEvent(
     sails: LoadedSails,
     userMessageSent: UserMessageSent,
   ): DecodedSailsEvent | null;

   /** Flat list of all (service, event) names declared in the IDL, including
    *  events from `service.extends` (v2 inherited services). */
   export function listEventNames(sails: LoadedSails): Array<{ service: string; event: string }>;

   /** Find a Sails event by name. Accepts "Service/Event" (always unambiguous)
    *  or bare "Event" name when it appears in exactly one service. Throws
    *  CliError("AMBIGUOUS_EVENT") on multi-service bare-name match with
    *  the alternatives listed. Returns null when the name is unknown. */
   export function resolveEventName(
     sails: LoadedSails,
     name: string,
   ): { service: string; event: string } | null;
   ```

   Implementation:
   - Walks `sails.services[S].events[E]` (shape identical for v1 and v2 — verified at `node_modules/sails-js/lib/sails.js:153` and `sails-idl-v2.js:320`).
   - For v2, recursively flatten `service.extends` (verified `service.extends` at `sails-idl-v2.d.ts:9`).
   - For each event, check `events[E].is(userMessageSent)`. First match wins.
   - Decoded payload runs through `decodeEventData` so nested U256/Option/etc. normalize identically to `call` replies.
   - `resolveEventName('Foo')` searches all services. Zero matches → `null`. Multi matches → throws `CliError('Ambiguous event "Foo" — matches A/Foo, B/Foo. Use full Service/Event form.', 'AMBIGUOUS_EVENT')`.

2. **`src/__tests__/sails-events.test.ts`** — `listEventNames`, `resolveEventName`, decode-no-match (mocked UserMessageSent), v2 extends propagation. ~5 tests.

3. **`src/__tests__/sails-events-decode.test.ts`** — uses real IDL fixtures (existing `sample-v2-events.idl` for v2; bundled VFT IDL for v1) to verify decoded payload shape. ~3 tests.

4. **`src/__tests__/call-events.test.ts`** — verifies `executeFunction` block-event filtering with PHASE-CORRELATED scoping. Mocks:
   - `api.at(blockHash)` returns an `apiAt` whose `query.system.events()` yields an array of records with `{ phase, event }`.
   - Records: one UserMessageSent in our extrinsic phase from our programId (✓ included), one UserMessageSent in a DIFFERENT phase from our programId (✗ excluded — wrong extrinsic), one UserMessageSent in our phase from a different program (✗ excluded — wrong source), one MessagesDispatched in our phase (✗ excluded — wrong type).
   - Asserts `events: [{service, event, data}]` contains exactly the one match.
   ~4 tests covering each filter dimension.

5. **`src/__tests__/watch-decoded.test.ts`** — verifies the new `formatUserMessageSentMaybeDecoded` helper. Uses real v2 sails instance + a synthesized `UserMessageSent`-shaped object (constructed via the registry's `createType` for the wire payload). Asserts decoded path emits `{event: 'UserMessageSent', payload: '0x…', sails: {service, event, data}, ...rawFields}` and undecoded path (no IDL) emits the same shape minus `sails`. ~3 tests.

6. **`src/__tests__/subscribe-filter-resolution.test.ts`** — verifies `resolveSubscribeFilter`:
   - Bare `Foo` with Gear vocab match → `{kind: pallet, event: 'UserMessageSent'}`
   - `Service/Event` form with Sails IDL → `{kind: sails, ...}`
   - Bare `Posted` matched in IDL only → `{kind: sails, ...}`
   - Ambiguous bare → throws `AMBIGUOUS_EVENT`
   - `--pallet-event` flag forces pallet path even with IDL.
   ~5 tests.

### MODIFIED

7. **`src/utils/decode-sails-result.ts`** — append `export const decodeEventData = decodeSailsResult;` (one line; no behavior change). Both `executeFunction` reply and `decodeSailsEvent` payload share the same walker so #32's fix automatically reaches event consumers.

8. **`src/utils/index.ts`** — re-export `decodeEventData`.

9. **`src/commands/subscribe/shared.ts`** — add helpers:

   ```ts
   /** Try to decode a UserMessageSent against an optional Sails IDL. Returns
    *  the existing raw shape unchanged; if a sails IDL is provided AND it
    *  matches the payload, append a `sails: {service, event, data}` key.
    *  Never mutates pre-existing field names — additive only. */
   export function formatUserMessageSentMaybeDecoded(
     event: UserMessageSent,
     sails: LoadedSails | null,
     programIdHex: string,
   ): Record<string, unknown>;

   /** Returns either a Gear pallet event match or a Sails event match.
    *  Resolution order (back-compat): Gear vocab first, then Sails IDL.
    *  `forcePallet` skips the IDL lookup entirely. Throws on ambiguous
    *  bare Sails names with the alternatives listed. */
   export type ResolvedSubscribeFilter =
     | { kind: 'sails'; service: string; event: string }
     | { kind: 'pallet'; event: GearEventName };

   export function resolveSubscribeFilter(
     name: string,
     sails: LoadedSails | null,
     forcePallet: boolean,
   ): ResolvedSubscribeFilter;
   ```

   `formatUserMessageSentMaybeDecoded` is the seam used by both `watch.ts` and `subscribe/messages.ts`. It calls `decodeSailsEvent` only when `programIdHex` matches `event.data.message.source.toHex()` — sails-js's own `.is()` doesn't check source, so we MUST pre-filter (Codex finding #2).

10. **`src/commands/watch.ts`** — add `--idl <path>` option and `--pallet-event` flag. Auto-load via `loadSailsAuto` when programId is given (Codex finding #3 — opportunistic, falls back gracefully on `IDL_NOT_FOUND`). When sails loaded, route through `formatUserMessageSentMaybeDecoded`. Validate `--event <type>` via `resolveSubscribeFilter` so `Service/Event` form is accepted alongside Gear vocab.

11. **`src/commands/subscribe/messages.ts`** — same treatment. `--idl`, `--pallet-event`, opportunistic auto-load. The `subscribe messages <programId>` command already implies program scoping, so auto-load is a free DX win.

12. **`src/commands/call.ts`** — extend `executeFunction` after `await result.response()`:

    ```ts
    // Phase-correlated block-event scan (Codex finding #1):
    // 1. Get the block + find OUR extrinsic index by matching txHash.
    // 2. Fetch system.events() at this block.
    // 3. Filter records where phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(ourIdx).
    // 4. From those, keep `gear.UserMessageSent` events (typed via api.events.gear.UserMessageSent.is).
    // 5. Filter source === programIdHex (defensive — phase scoping should already exclude).
    // 6. Run each through decodeSailsEvent.
    const events = await collectDecodedEvents(api, sails, result.blockHash, result.txHash, programIdHex);
    output({
      txHash: result.txHash, blockHash: result.blockHash, blockNumber,
      messageId: result.msgId, voucherId: options.voucher ?? null,
      result: decoded,
      events,  // additive — always present, may be []
    });
    ```

    `collectDecodedEvents` lives in `src/services/sails-events.ts` (it composes `decodeSailsEvent` with the block-walk logic — sized at ~30 lines, kept out of `call.ts` so the command stays thin).

    Implementation sketch for `collectDecodedEvents`:
    ```ts
    export async function collectDecodedEvents(
      api: GearApi, sails: LoadedSails,
      blockHash: HexString, txHash: HexString, programIdHex: HexString,
    ): Promise<DecodedSailsEvent[]> {
      const block = await api.rpc.chain.getBlock(blockHash);
      const extrinsicIdx = block.block.extrinsics.findIndex((x) => x.hash.toHex() === txHash);
      if (extrinsicIdx < 0) return [];   // shouldn't happen — txHash came from this block
      const apiAt = await api.at(blockHash);
      const records = await apiAt.query.system.events();
      const out: DecodedSailsEvent[] = [];
      for (const record of records as unknown as Array<{ phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { eq: (n: number) => boolean } }; event: unknown }>) {
        if (!record.phase.isApplyExtrinsic || !record.phase.asApplyExtrinsic.eq(extrinsicIdx)) continue;
        if (!api.events.gear.UserMessageSent.is(record.event as never)) continue;
        const ums = record.event as unknown as UserMessageSent;
        if (ums.data.message.source.toHex() !== programIdHex) continue;
        const decoded = decodeSailsEvent(sails, ums);
        if (decoded) out.push(decoded);
      }
      return out;
    }
    ```

    Backward-compat: `events` is a NEW key. No existing field changes. Per Codex finding #2, source filter stays even though phase scoping is more accurate — defense-in-depth costs nothing.

## v1/v2 dispatch shape

Mirrors `coerceArgs` / `coerceArgsV2` / `coerceArgsAuto`:
- `coerceArgsAuto` picks once via `isSailsV2(sails)`, dispatches to one walker.
- `decodeSailsResult` (existing) dispatches inside `walk()` via `isSailsV2`.
- `decodeSailsEvent` does NOT dispatch on v1/v2 because both expose identical `events[E].is/decode` surface. The v1/v2 split is invoked transitively when the decoded value flows into `decodeEventData → decodeSailsResult → walkV1/walkV2`.
- v2 `service.extends` traversal is v2-only (v1 has no `extends`); guarded by `isSailsV2`.

One new module, zero new dispatch surface.

## Output shape (Codex finding #6 — namespace, don't collide)

`watch` and `subscribe messages` decoded output:
```json
{
  "type": "message",
  "event": "UserMessageSent",        // unchanged — pallet name
  "messageId": "0x…",                 // unchanged
  "source": "0x…",                    // unchanged
  "destination": "0x…",               // unchanged
  "payload": "0x…",                   // unchanged — raw hex
  "payloadAscii": "…",                // unchanged
  "value": "0",                       // unchanged
  "details": null,                    // unchanged
  "sails": {                          // NEW — only present on successful decode
    "service": "Chat",
    "event": "MessagePosted",
    "data": { /* recursively decoded JSON */ }
  },
  "timestamp": 1234567890
}
```

When IDL absent or no decode match: shape is exactly as today — no `sails` key. Consumers that ignore unknown keys remain compatible. Persisted SQLite event rows store the full JSON object as `data`, so the schema stays the same.

## Verification

- `npx tsc --noEmit` clean
- `npm test` ≥ 463 (baseline 446 + 17 new)
- No lint script (verified `package.json`)

## Test count delta

- 5 in `sails-events.test.ts` (list, resolve x3, extends, decode-no-match)
- 3 in `sails-events-decode.test.ts` (v1 happy, v2 happy, v2 extended-service event)
- 4 in `call-events.test.ts` (no-match, single-extrinsic match, cross-extrinsic exclusion, cross-program exclusion)
- 3 in `watch-decoded.test.ts` (decoded match, no-IDL fallback, source-mismatch no-decode)
- 2 in `subscribe-filter-resolution.test.ts` (Gear-first precedence + ambiguous Sails) — NB: tightened from 5 to 2; the other 3 are subsumed by sails-events.test.ts

Total: **+17 tests**, target final = 463.

## Out of scope

- Issues #20, #33, #35 — separate PRs per parent plan critical sequencing.
- SS58/ActorId in event output (#31 closed).
- `MessageWaken` vs `MessageWoken` typo in `VALID_GEAR_EVENTS` — pre-existing, separate fix.
- Auto-load IDL for `watch` / `subscribe messages` will silently fall back to raw output on resolution failure. No new error code added; verbose logs the failure. (If a user explicitly passes `--idl bad-path.idl`, that error still propagates as `IDL_FILE_ERROR`.)

## Commit / branch / ship

- Branch: `feat/sails-event-decoding`
- Single commit: `feat: IDL-aware Sails event decoding and recursive value decode (closes #36, #37, #32)`
- No `--no-verify`, no `--amend`.
- After commit: `/review` skill (review-pr) → apply blocking fixes → `/ship`.

## Decision audit (from /autoplan)

| # | Phase | Decision | Principle | Rationale |
|---|-------|----------|-----------|-----------|
| 1 | CEO | Skip duplicate `decode-result.ts`; reuse `decode-sails-result.ts` | P4 (DRY) | Forking the walker would be 100% duplicated logic |
| 2 | CEO | Run consolidated codex review (1 invocation) instead of 4 phase-by-phase | P3 (Pragmatic) | Spawned subagent, time budget; signal preserved |
| 3 | CEO | Skip Phase 2 (Design) | Mechanical | No UI scope detected — CLI tool |
| 4 | Eng | Phase-correlated event scan vs whole-block scan | P1 (Completeness) | Codex caught the cross-extrinsic bleed bug; phase scoping is the correct fix |
| 5 | Eng | Auto-load IDL for watch/subscribe (opportunistic) | P1 + P2 (Completeness, blast radius) | `loadSailsAuto` already exists; this is in-blast-radius and < 1 day CC |
| 6 | DX | Output shape: namespace under `sails:` | P5 (Explicit over clever) | `event` reuse would be a breaking schema change; `sails:` is unambiguous |
| 7 | DX | Gear-first precedence on `--type` / `--event` | P3 + back-compat | Existing users have Gear vocab muscle memory; Sails users learn `Service/Event` form |
| 8 | DX | Hard-fail (not soft-warn) on ambiguous bare Sails names | P5 | Filter commands cannot be nondeterministic |
| 9 | Eng | Defer `MessageWaken→MessageWoken` typo fix | P2 (lake boundary) | Out of blast radius for this PR; back-compat audit needed |
| 10 | Eng | Use `api.events.gear.UserMessageSent.is()` for typed event check, not blind cast | P5 | Codex finding #1 secondary fix; canonical polkadot pattern |
| 11 | Eng | v2 service `extends` traversal | P1 | Codex finding #7; forgotten edge case caught |

User-challenge gate: none — no model recommended changes that contradict the user's stated direction (IDL-aware decoding remains the goal; all 11 decisions refine HOW, not WHAT).

Premise gate: premises validated by codex (v1+v2 share is/decode surface, gear/UserMessageSent section/method names correct, decode-sails-result reuse correct).
