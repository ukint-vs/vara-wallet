# TODOs

## Full payload codec system
**Priority:** P3 | **Effort:** L (human ~2 weeks / CC ~2 hours)

Auto-detect payload type (SCALE-encoded, UTF-8 text, raw binary) and pretty-print
with optional IDL context. Every payload surface in the CLI would intelligently render
content based on detected type, with `--format` flags for output control.

**Context:** Currently the CLI supports hex payloads and (as of v0.4.0) ASCII text via
`--payload-ascii` and `tryHexToText`. The next step is SCALE decoding with IDL context,
which would let agents read structured program responses without external tooling.

**Depends on:** ASCII payload support (completed).
