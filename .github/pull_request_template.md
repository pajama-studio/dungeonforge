<!--
Thanks for the patch. CI runs typecheck, tests and build; everything below is
about the things CI cannot see.
-->

## What this changes

<!-- What is different in the world now, and why. -->

## How you checked it

<!--
Rendering and startup cost cannot be verified headlessly — see CONTRIBUTING.md.
If this touches the renderer, materials, scene assembly or streaming, say which
browser and GPU you looked at it on, and attach a before/after screenshot.

If it touches performance, paste the numbers. `scripts/startup-benchmark.mjs`
reports first visible frame, decor ready, longest render block and pipeline
counts; before and after from the same machine is what this project treats as
evidence.
-->

- [ ] `npm run typecheck`, `npm test`, `npm run build` pass
- [ ] Looked at it in a real WebGPU browser (if it changes anything visible)

## Anything you are unsure about

<!-- Tradeoffs you made, alternatives you rejected, things you want a second opinion on. -->
