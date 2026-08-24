# Licenses & Asset Credits

## Code

All original code in this repository is released under the **MIT License** (see `LICENSE`).

## Third-party libraries

| Library | License | Source |
|---|---|---|
| three.js | MIT | https://github.com/mrdoob/three.js |
| Draco 3D Data Compression decoder — `public/draco/**` | **Apache-2.0** | https://github.com/google/draco |

`public/draco/**` is Google's decoder, redistributed unmodified as three.js
bundles it. Apache-2.0 requires the license to travel with the binaries, so the
full terms sit beside them in [`public/draco/LICENSE`](public/draco/LICENSE),
with provenance and the copyright notice in
[`public/draco/README.md`](public/draco/README.md). Those files serve the dev
server only — production loads three's own content-hashed decoder and the build
drops this copy from `dist/`.

MarkovJunior's license is kept in [`third_party/`](third_party/) as attribution
for the technique the rule-rewrite generator follows; no code was vendored.

## Art assets

| Asset | Author | License | Source |
|---|---|---|---|
| `public/assets/skeleton.glb`, `public/assets/skeleton-game.glb` — Skeleton Minion (KayKit Skeletons Character Pack 1.0) | Kay Lousberg | **CC0 1.0** (public domain) | https://kaylousberg.com · https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0 |
| Dragon, titan skull, oracle, warden and horizon landmark meshes | Dungeonforge project (AI-assisted generation, then remeshed and decimated locally) | MIT, same as the code | Streamed from `props.pajama.studio` — see below |

KayKit assets are CC0 — free for personal, educational and commercial use with
no attribution required. We credit **Kay Lousberg (kaylousberg.com)** anyway,
with thanks, as the pack suggests.

### Where the landmark meshes live

They are **not in this repository**. `.gitignore` excludes `public/assets/**/*.glb`
(the two KayKit skeletons are the deliberate exceptions, kept here so the
third-party work stays beside its attribution). The project's own meshes are
served from the content-addressed shelf at `props.pajama.studio`, pinned by
`src/asset-urls.json`, and `npm run assets:pull` caches them locally for offline
work. They carry the same MIT license as the code.

Everything else rendered in this project — the stone kit, masonry, vegetation,
brambles, canyon, terrain, water, particles and effects — is generated
procedurally by code in this repository.
