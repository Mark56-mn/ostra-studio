// Ambient declarations for non-code side-effect imports.
//
// Next.js resolves these at build time, but TypeScript 7 (currently `latest` on
// npm) errors on side-effect imports of unknown modules with TS2882. Declaring
// the wildcard patterns keeps `tsc --noEmit` green on both TypeScript 5 and 7.
declare module "*.css";
declare module "*.scss";
declare module "*.sass";
