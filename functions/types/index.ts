// ============================================================================
// Module-resolution shim for the MIRRORED ragDerivation module.
//
// lib/ragDerivation.ts is kept byte-for-byte identical with the web copy
// (fireritesite/src/console/settings/ragDerivation.ts) by verify-schema-mirror.sh,
// so its `import ... from '../../types'` cannot be edited to point at the
// Functions' own types location. On the web that path resolves to src/types; here
// it resolves to functions/types - this file - which simply re-exports the
// canonical mirrored contract. No types live here; there is still exactly ONE
// Functions-side copy of the schema (src/shared/types).
// ============================================================================

export * from '../src/shared/types';
