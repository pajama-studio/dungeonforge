# Security Policy

Dungeonforge is a static, client-side browser application. It has no backend,
no accounts, no database, and stores nothing about you: the whole world is
computed locally from a seed in the URL. The only network requests it makes are
for its own bundle and for the landmark meshes on `props.pajama.studio`.

That keeps the realistic attack surface small, but not empty. Things worth
reporting:

- A crafted `?seed=` / query parameter that causes something worse than a
  failed forge — an infinite loop that hangs the tab, unbounded memory growth,
  or anything that escapes the canvas.
- Any path where page content ends up interpreted as code.
- A dependency advisory that actually reaches this app's runtime.
- Anything on `props.pajama.studio` serving bytes that do not match the content
  hash they are addressed by.

## Reporting

Please **do not** open a public issue for a security problem. Use GitHub's
private vulnerability reporting on this repository
(**Security → Report a vulnerability**).

Tell us the browser and GPU, the URL that reproduces it, and what you observed.
We will acknowledge within a week and tell you either what we are doing about
it or why we think it is not a vulnerability.

## Supported versions

The deployment at <https://dungeonforge.pajama.studio> and the `master` branch.
There are no maintained release branches.
