# Proposals for sails-js upstream

Notes collected while integrating `sails-js@1.0.0-beta.1` into vara-wallet as the
first dual-IDL (v1 + v2) consumer. Each item is something the library should
handle or expose so consumers don't have to reach into private fields or
reimplement logic the library already has internally.

Reference integration: [feat/sails-js-1.0.0-beta-dual-idl](https://github.com/gear-foundation/vara-wallet/pull/29).

---

## 1. Expose a public way to enumerate user-defined types (P1)

**What we do now.** Both vara-wallet's hex-coercion walker and its `describe` helper
need the raw `struct` / `enum` / `alias` definitions so they can walk fields and
resolve user types. sails-js builds that data internally in `TypeResolver._userTypes`
and in the parsed `IIdlDoc`, but neither is public. Our workaround is a
`getRegistryTypes(program)` helper that reads `(program as any)._doc.program.types`
and `(program as any)._doc.services[i].types`.

**Why this matters.** Any consumer that wants to do its own payload validation,
pretty-printing, dead-typed-arg detection, or custom arg coercion runs into this
wall. The escape hatch — reaching into `_doc` — is fragile across beta releases
and every consumer that does it will break the same way at the same time.

**Proposal.** Add public accessors on `SailsProgram`:

```ts
// Program-level types (ambient), indexed by name.
program.programTypes: ReadonlyMap<string, Type>

// Service-local types. Two services can legitimately declare the same-named
// type with different shapes — keying by service avoids cross-service
// collision in a flat global map (see proposal #2).
program.serviceTypes(serviceName: string): ReadonlyMap<string, Type>

// Or equivalent: program.services[name].types as a Record<string, Type>.
```

Bonus: export the `Type` / `TypeDecl` / `ITypeStruct` / `ITypeEnum` / `ITypeAlias`
type definitions from the top-level `sails-js` entry (they exist in
`sails-js-types` but that package is private/workspace-only). Consumers today
have to redeclare these unions locally (see our `V2TypeDecl` duplicate in
`src/utils/hex-bytes.ts`).

---

## 2. Service-scoped type resolution as a first-class concept (P1)

**What we do now.** We take a `serviceName` parameter in our `coerceArgsV2` and
use it to narrow the lookup map: program-level types + that service's types
only, never cross-service flattened. Without this, two services declaring the
same-named struct silently overwrite each other in the type map and arg
coercion runs against the wrong shape.

**Why this matters.** IDL v2 makes service-local types idiomatic
(the spec literally has a per-service `types { ... }` block), yet the library
doesn't provide a resolver scoped to "I'm calling into service X — what does
`Packet` mean in this context?". Every consumer that resolves types must
either flatten (bug) or rebuild this scoping themselves.

**Proposal.** Extend `TypeResolver` with scope awareness:

```ts
class TypeResolver {
  // Resolve a TypeDecl to its concrete definition in the context of a service.
  // Program-level types are always visible; service-local types shadow only
  // within that service's scope.
  resolveInService(serviceName: string, typeDecl: TypeDecl): Type | undefined

  // Scoped struct-field / enum-variant expansion.
  getTypeDeclStringInService(serviceName: string, typeDecl: TypeDecl, nameKind?: NameKind): string
}
```

Alternative shape: hang the resolver off each service exposed on
`SailsProgram.services[name]`:

```ts
interface SailsService {
  resolveType(typeDecl: TypeDecl): Type | undefined
  renderType(typeDecl: TypeDecl, nameKind?: NameKind): string
}
```

---

## 3. Generic-parameter substitution in TypeResolver / TypeDecl walker (P1)

**What we do now.** A v2 struct like `Packet<T> { payload: T }` used as
`Packet<[u8]>` leaves hex strings uncoerced in our walker because we never
substitute `T → [u8]` before recursing into `field.type`. Fix is straightforward
(thread a substitutions `Map<string, TypeDecl>` through the recursion and
resolve each generic through the current scope before entering the next), but
every consumer that walks v2 types has to reinvent this.

**Why this matters.** `TypeResolver.getTypeDeclString` already does generic
substitution internally when rendering a name. It just doesn't expose a
"resolve a TypeDecl to its fully-substituted form" method that consumers can
feed to their own walkers.

**Proposal.** Add a public substitution helper:

```ts
class TypeResolver {
  // Substitute generics recursively. Returns a TypeDecl with all type_params
  // replaced by their resolved forms. Idempotent.
  substituteGenerics(typeDecl: TypeDecl, generics?: TypeDecl[], paramNames?: string[]): TypeDecl
}
```

Or: a walker callback API:

```ts
class TypeResolver {
  walkTypeDecl(
    typeDecl: TypeDecl,
    visitor: {
      onPrimitive?(name: PrimitiveType, ctx: WalkerCtx): void;
      onSlice?(item: TypeDecl, ctx: WalkerCtx): void;
      onArray?(item: TypeDecl, len: number, ctx: WalkerCtx): void;
      onTuple?(types: TypeDecl[], ctx: WalkerCtx): void;
      onStruct?(def: ITypeStruct, resolvedFields: IStructField[], ctx: WalkerCtx): void;
      onEnum?(def: ITypeEnum, resolvedVariants: IEnumVariant[], ctx: WalkerCtx): void;
    },
    ctx?: { serviceName?: string; generics?: Map<string, TypeDecl> }
  ): void
}
```

The walker handles substitution, user-type lookup, alias expansion, and service
scoping so consumers never touch `_doc` or re-implement the resolution logic.

---

## 4. Stringifier for named-field events (P2)

**What we do now.** `SailsProgram.services[x].events[y].type` is a pre-rendered
string for unit variants (`'Null'`) and single-unnamed payloads (`'u32'`), but
an object (from `TypeResolver.getStructDef(fields)`) for events with named
fields like `Walked { from: (i32,i32), to: (i32,i32) }`. Consumers that want a
uniform string representation fall through to `typeDef`, which is an
`IServiceEvent`, not a `TypeDecl` — so `TypeResolver.getTypeDeclString` rejects
it. vara-wallet's `discover` output renders such events as `"unknown"`.

**Proposal.** Make `event.type` always a string (or expose
`event.typeString` as a stable getter). Internally call
`TypeResolver.getStructDef(event.fields, {}, /* stringify */ true)` for the
named-field case — that code already exists at
`js/src/sails-idl-v2.ts:509-511`. Just default `stringify` to `true` for the
public field.

Alternative: expose `event.render(nameKind?)` as a method that consumers can
call; keep the object form available for those who want structured access.

---

## 5. Cycle detection in TypeResolver for recursive user types (P2)

**What we do now.** Our walker recurses into alias and user-defined types
without cycle detection. A pathological IDL with `type Foo = Foo` (or mutual
recursion `Foo → Bar → Foo` via aliases) would stack-overflow the process.
The sails parser probably rejects this at parse time, but consumers take
parsed output at face value.

**Proposal.** Have the parser reject cyclic aliases explicitly and document it.
Or add a `TypeResolver.detectCycles()` diagnostic that consumers can call
after parsing.

---

## 6. Publish sails-js-types (or re-export its types from sails-js) (P2)

**What we do now.** `TypeDecl`, `Type`, `ITypeStruct`, `ITypeEnum`, `ITypeAlias`,
`IFuncParam`, `IServiceEvent` etc. live in the private workspace package
`sails-js-types`. Consumers who want typed access to the IDL AST (for
inspection, validation, codegen, custom encoding) have to either:
- re-declare the union (what we did — see `V2TypeDecl` in `src/utils/hex-bytes.ts`), or
- peek at the deep import path `sails-js/lib/types` which isn't part of the `exports` field.

**Proposal.** Either publish `sails-js-types` to npm alongside `sails-js`, or
re-export the full AST typings from `sails-js` itself:

```ts
// sails-js top-level exports
export type {
  TypeDecl, Type, PrimitiveType,
  ITypeStruct, ITypeEnum, ITypeAlias, ITypeParameter,
  IStructField, IEnumVariant,
  IFuncParam, IServiceFunc, IServiceEvent, IServiceUnit,
  ICtorFunc, IProgramUnit, IIdlDoc,
} from 'sails-js-types';
```

This also lets consumers write AST-aware code without `as any`.

---

## 7. Typed parse errors (P3)

**What we do now.** When `parser.parse(idl)` fails, it throws a plain `Error`
with message `"Error code: N, Error details: ..."`. Consumers can't
programmatically distinguish "syntax error" from "validation error"
(e.g., computed-vs-declared `interface_id` mismatch) from "WASM runtime
failure" except by parsing the message string.

**Proposal.** Export typed error classes:

```ts
class SailsIdlParseError extends Error {
  code: 'SYNTAX' | 'VALIDATION' | 'WASM_RUNTIME' | 'UNKNOWN';
  // For validation errors, structured fields:
  service?: string;          // e.g., "A"
  expectedInterfaceId?: `0x${string}`;
  computedInterfaceId?: `0x${string}`;
}
```

Consumers can then do `err instanceof SailsIdlParseError` and branch on
`err.code`. vara-wallet currently reparses error messages in
`detectIdlVersion`'s fallback path — fragile.

---

## 8. Parser singleton helper / init recovery (P3)

**What we do now.** `SailsIdlParser` (v2 variant) requires a two-step
construction: `new SailsIdlParser(); await parser.init()`. Consumers who want
to share one parser across a process have to hand-roll a singleton, AND they
have to remember that a rejected `init()` promise must be reset — otherwise a
transient WASM-decompression hiccup wedges the process on a permanently
rejected Promise.

**Proposal.** Ship a `SailsIdlParser.getOrInit()` static helper that caches
the initialized parser per-process and resets the cache on failure. Or at
minimum, document the init contract explicitly — "single init() call, cache
the result yourself, reset on rejection."

```ts
class SailsIdlParser {
  // Process-wide singleton with automatic recovery on init failure.
  static getOrInit(): Promise<SailsIdlParser>
}
```

---

## 9. Make v1 IDLs self-identify (P3 / optional)

**What we do now.** v2 IDLs carry `!@sails: <version>` on their first
non-blank line; v1 IDLs have no marker. We detect v2 via regex and fall back
to "try v1 parser, if that fails try v2" for the ambiguous case. Works, but
means a v1 IDL that embeds `!@sails:` in a doc comment (e.g.,
`/// Example: !@sails: 1.0.0-beta.1`) gets misclassified and fails without
fallback.

**Proposal.** Either:
- Require the directive at document start only (line 1 after leading blanks),
  tightening the spec, OR
- Add a mirror marker `!@sails: 0.x` to v1 IDLs retroactively so detection is
  unambiguous, OR
- Publish a `detectVersion(idlText): 'v1' | 'v2' | 'unknown'` helper in
  sails-js so every consumer uses the same algorithm.

The third is cheapest for upstream and removes the risk of consumers diverging
on the detection heuristic.

---

## 10. Unified package or clearer split between v1 and v2 (P3)

**What we do now.** `sails-js-parser@0.5.1` is the v1 parser (separate npm
package). `sails-js@1.0.0-beta.1` bundles the v2 parser at the `./parser`
subpath export. Dual-IDL consumers install both packages. The version fields
don't line up (the v2 parser ships inside a tarball whose `package.json` still
says `version: 0.5.1` — cosmetic but confusing; `npm ls sails-js` reports
0.5.1 even though the code is 1.0.0-beta.1 content).

**Proposal.**
- Publish `sails-js@1.0.0-beta.1` (actually bump the `version` field in the
  tarball, not just the git tag).
- Fold the v1 parser into `sails-js` at a `./parser-v1` subpath, keeping the
  `sails-js-parser` package as a thin re-export. One install, both parsers.
- Or: deprecate `sails-js-parser` at GA and migrate its exports under
  `sails-js@1.x`.

---

## 11. Expose interface_id computation (P3)

**What we do now.** The v2 parser rejects an IDL when its declared
`@0x<interface_id>` doesn't match the content-derived hash, printing the
expected value. Consumers writing or editing v2 IDLs (tests, codegen, fixtures)
have to iterate: submit IDL → read error → paste the hex back → retry.

**Proposal.** Export the interface-id algorithm so tooling can compute the
correct suffix from the service signature without a round-trip through the
parser:

```ts
import { computeInterfaceId } from 'sails-js/parser';

const id = computeInterfaceId({
  name: 'Counter',
  functions: [{ name: 'Add', params: [{ name: 'value', type: 'u32' }], output: 'u32' }],
  events: [{ name: 'Added', fields: [{ type: 'u32' }] }],
});
// → '0x579d6daba41b7d82'
```

Enables codegen, editor tooling, and test fixtures that don't drift when a
signature changes.

---

## 12. Lazy WASM load (P4, bundle-size)

**What we do now.** Both parsers ship their Rust WASM as a base64-encoded
gzipped blob in a JS module. Bundling the v2 parser adds ~145KB of base64 to
the bundle (plus ~97KB for v1). For the sails-js-consuming CLI at vara-wallet,
`dist/app.js` weighs 3.3 MB — a meaningful fraction of that is the two WASM
blobs, even though any given invocation only exercises one parser.

**Proposal.** Emit the WASM as a sibling `.wasm` asset and load it lazily via
`fs.readFileSync` (Node) or `fetch` (browser). Bundlers that support
`import.meta.url` can inline when needed. Halves the at-startup parse cost of
the base64 string in V8 and lets tree-shakers skip the unused parser when a
consumer opts in to only one version.

---

## Summary of priorities

| # | Proposal | Priority | Consumer pain level |
|---|----------|----------|---------------------|
| 1 | Public type-map accessors | **P1** | High — forces private `_doc` access across the codebase |
| 2 | Service-scoped type resolution | **P1** | High — silent mis-coercion on name collisions |
| 3 | Generic substitution helper | **P1** | High — silent mis-coercion when generics are used |
| 4 | Always-string event `.type` | P2 | Medium — discover output gap |
| 5 | Cycle detection | P2 | Low — pathological IDL only |
| 6 | Publish / re-export types | P2 | Medium — forces type-decl duplication |
| 7 | Typed parse errors | P3 | Medium — fragile message parsing in detection fallback |
| 8 | Parser singleton helper | P3 | Low — easy to hand-roll once it's documented |
| 9 | Unambiguous version marker | P3 | Low — our detection is permissive by design |
| 10 | Unified package shape | P3 | Low — cosmetic, once npm publish lands |
| 11 | Exposed `computeInterfaceId` | P3 | Medium — high DX win for IDL authors and tooling |
| 12 | Lazy WASM load | P4 | Low — bundle-size concern only |

Proposals #1, #2, and #3 together would let us delete ~350 lines of workaround
code in vara-wallet and eliminate three classes of silent correctness bugs.
#4–#6 remove the need for `as any` and private-field access entirely.
