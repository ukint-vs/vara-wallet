// Type shim for the `sails-js/parser` subpath export.
//
// sails-js 1.0.0-beta.1 publishes the v2 IDL parser under the `exports` field
// at "./parser". With `moduleResolution: "node"` TypeScript does not respect
// package `exports`, so we redirect it here.
//
// Safe to delete once we migrate to `moduleResolution: "node16"` or "bundler".

declare module 'sails-js/parser' {
  export * from 'sails-js/lib/parser';
}
