import { writeFileSync } from "node:fs";

writeFileSync("src/gen/wasm-pkg/.gitignore", `# wasm-pack creates this directory as a publishable package. Dungeonforge also
# checks the tiny runtime artefacts in so the demo needs no Rust toolchain.
*
!dungeon_core.js
!dungeon_core.d.ts
!dungeon_core_bg.wasm
!dungeon_core_bg.wasm.d.ts
!package.json
!.gitignore
`);
