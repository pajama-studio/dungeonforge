/// <reference types="vite/client" />

// Without this, `import.meta.env` type-checks as a bare ImportMeta and every
// read of it is an error — which the build never notices, because Vite rewrites
// those reads before tsc would ever see them.
