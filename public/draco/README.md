# Draco decoder (vendored)

These files are the Draco 3D Data Compression decoder, copied byte-for-byte
from `three/examples/jsm/libs/draco/` (three.js r185), which in turn ships
Google's official builds.

    Copyright 2017 The Draco Authors

Licensed under the Apache License, Version 2.0. The full terms are in
[`LICENSE`](LICENSE) beside this file; you may also obtain a copy at
<http://www.apache.org/licenses/LICENSE-2.0>. The files are redistributed
unmodified.

* Upstream: <https://github.com/google/draco>
* Bundled by: <https://github.com/mrdoob/three.js>

## Why the copy exists

Only the development server uses it. `src/scene/gltf-draco.ts` points
`DRACOLoader` at `/draco/gltf/` under Vite dev, because Vite 6's dependency
optimiser rewrites three's own relative decoder URL to a path where the SPA
fallback answers with HTML.

Production does **not** ship these bytes: the build resolves `DRACO_GLTF_CONFIG`
to three's content-hashed decoder and `vite.config.ts` deletes this directory
out of `dist/` (it prints `not bundled (superseded public Draco copy)` when it
does). The two decoder variants here — the default build and the smaller
glTF-targeted one in `gltf/` — mirror upstream's own layout; only `gltf/` is
loaded.
