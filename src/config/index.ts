// Mobile only re-exports `mobile.ts` (parseMobileEnv) and the shared
// `helpers.ts` zod refinement helpers. The other config modules
// (api.ts, auth-gateway.ts, desktop-agent.ts) were copied verbatim
// from the backend monorepo for parity but they evaluate Node-only
// APIs at module-load (e.g. desktop-agent.ts:37 calls `process.cwd()`)
// which doesn't exist in React Native. Importing them here crashes
// the JS runtime during initial bundle eval.
//
// Phase 3.4 standalone migration: gate the re-exports so only the
// mobile-safe modules surface from `@operator-os/config`. The other
// files remain on disk as documentation but are dead code in the
// mobile context.
export * from './helpers.js';
export * from './mobile.js';
