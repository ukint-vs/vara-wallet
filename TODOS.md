# TODOs

## Program list --owner filter
**Priority:** P3 | **Effort:** M (human ~2 days / CC ~30 min)

Add `--owner <address>` filter to `program list` to find programs deployed by a specific
account. Requires an indexer-backed endpoint for server-side filtering; client-side filtering
would be O(n) RPC calls on mainnet. Deferred from the v0.9.0 DX audit.

**Depends on:** Indexer support for program ownership queries.

## Full payload codec system
**Priority:** P3 | **Effort:** L (human ~2 weeks / CC ~2 hours)

Auto-detect payload type (SCALE-encoded, UTF-8 text, raw binary) and pretty-print
with optional IDL context. Every payload surface in the CLI would intelligently render
content based on detected type, with `--format` flags for output control.

**Context:** Currently the CLI supports hex payloads, ASCII text via `--payload-ascii`
and `tryHexToText`, and IDL-based constructor encoding via `--idl`/`--init`/`--args`
on `program upload`/`deploy` (added in v0.8.0). The remaining scope is SCALE decoding
of program responses with IDL context, which would let agents read structured replies
without external tooling.

**Depends on:** ASCII payload support (completed). Constructor encoding (completed v0.8.0).

## Voucher auto-discovery
**Priority:** P3 | **Effort:** S (human ~1 day / CC ~15 min)

Add `--voucher auto` mode that queries `api.voucher.getAllForAccount()` and selects the
best available voucher for the target program. Falls back to explicit `--voucher <id>` if
multiple vouchers match or none exist. Also consider `VARA_VOUCHER_ID` env var for agent
workflows.

**Context:** v0.6.0 added explicit `--voucher <id>` to all write commands. Auto-discovery
would complete the sponsored execution UX by removing the need to copy-paste voucher IDs.

**Depends on:** `--voucher` flag support (completed v0.6.0).
