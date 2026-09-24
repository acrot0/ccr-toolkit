# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Release workflow: pushing a `v*` tag runs the full test suite, verifies the
  packed tarball against the `files` field, and publishes to npm with
  provenance. `workflow_dispatch` with `dry_run: true` rehearses everything
  short of publishing.

### Changed

- The main entry point's bin is now **`ccr-toolkit`**, not `ccr` — the upstream
  CCR CLI already owns `ccr`, so a global install of both packages would
  collide (npm refuses with EEXIST, leaving whichever installed second broken).
- npm metadata (`repository`/`bugs`/`homepage`) — `npm publish --provenance`
  requires a `repository` field, and the npm page should link back here.
- README: npm install path documented; fixed the `<you>` placeholder left in
  the clone URL.

## [0.2.0] — 2026-09-24

Six tools. The three added in this release all answer questions the first three
could not, and each was built against a measured failure on a real install.

### Added

- **`ccr-doctor`** — reads the upstream's own explanation out of
  `response_body_text` and names the fault. Measured: 4 of 7 failures carried an
  empty `error` column, and in all 4 the answer was recoverable from the body.
  Eight classes, each with a next action.
- **`ccr-trace`** — replays the per-request hop chain (7 hops for a normal call,
  up to 16 for a retried one) and marks the failing hop. A 400 failing at hop ≤3
  was malformed before the gateway touched it; at hop 6 it came back rejected
  from upstream. Same status code, opposite fix.
- **`ccr-body`** — recovers the `model` field from bodies whose middle CCR cut
  out. Measured: 96% of stored bodies are folded, and 300 of 300 folded bodies
  still yielded the model. Answers the most common gateway failure report,
  *"Missing model in request body"* (28 open issues upstream).

### Fixed

- `ccr-check` no longer exits 1 when CCR is not installed — that is "not
  applicable", not a fault, and it made the tool unusable in CI.
- `--json` mode now sets the exit code. It previously always exited 0, so a CI
  gate would have passed on a real threat.

### Notes

- Requires Node ≥ 22.13 (`node:sqlite` stayed behind `--experimental-sqlite`
  until 22.13.0).
- All tools open databases read-only and never write to your config.

## [0.1.0] — 2026-09-24

### Added

- **`ccr-cache`** — prompt cache hit rate per `provider|model`, auto-detecting
  the reporting convention per row (`remainder` vs `total`; using the wrong one
  reads 99.9% as 50%).
- **`ccr-check`** — gateway health: fallback mode, profile slots, database
  bloat, request-body preview loss, `status=0` logging gaps, rate-limit bursts.
- **`ccr-takeover`** — audits CCR's config-takeover backup chain and reports
  which snapshot CCR would restore, and whether it is healthy.

[Unreleased]: https://github.com/acrot0/ccr-toolkit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/acrot0/ccr-toolkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/acrot0/ccr-toolkit/releases/tag/v0.1.0
