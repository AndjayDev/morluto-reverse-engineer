# Tasks

Sequencing is shared with the companion
[background analysis jobs](https://github.com/morluto/rea/issues/5271) work.
Each slice is reviewable on its own and keeps `main` behaviour unchanged until
its contract step lands.

## Slice MT-1: registry refactor (no behaviour change)

1. [x] Add `BinaryTargetRegistry` with one slot per target. Each slot keeps the
       existing `BinarySession` lifecycle lock, provider client, snapshot cache, and
       cancellation scope.
2. [x] Keep the public `BinarySessionPort` shape, adding only optional
       `target_id` routing parameters.
3. [x] Gate: existing `BinarySession*` tests pass unchanged.

## Slice MT-2: target routing and caps

4. [x] Add `target_id` generation, reopen-returns-same-id by path, and
       `keep_others_open` (default `false`).
5. [x] Add optional `target_id` to every official analysis tool contract, and
       route once in `withAdmittedAnalysis`. Add `target_not_open` without exposing
       target paths.
6. [x] Add `REA_MAX_OPEN_TARGETS` (default 4) and `capacity` refusal.
7. [x] Unit tests for caps, unknown id, replacement, and per-slot routing.
8. [ ] Regenerate the tool catalog and update `docs/mcp-contracts.md` and
       `docs/tool-design.md` for the selector.
9. [ ] Extend the remaining target-bound families (enhanced workflows, native,
       artifact, managed, and provider-specific tools) with the same selector.
       Official tools and lifecycle tools are covered in this slice.

## Slice MT-3: concurrency queue

10. [x] Add `REA_MAX_CONCURRENT_ANALYSES` (default 2) and FIFO start admission.
        Foreground opens and background jobs take the same permit, so a background
        start beyond the cap is queued rather than refused, and the number of
        overlapping provider starts stays inside the cap.
11. [ ] Add `rea analyze <path>... --concurrency N` on the registry in one
        process, using the project cache.
12. [x] Gate: queue ordering test.
13. [ ] CLI JSON output test for the batch command.

## Background jobs

Moved to the companion [analysis-jobs](https://github.com/morluto/rea/issues/5271)
draft so the two contract changes can be reviewed separately.

## Real-provider verification (required before any claim)

14. [ ] Linux x64, Ghidra 12.1.4: two real PEs analysed concurrently versus
        serially, with wall time and peak process-family RSS.
15. [ ] Boundary test with two MCP targets over stdio. The in-memory MCP test is
        present; the built boundary runner could not execute here because the
        Windows native controls are not built in this worktree.
16. [ ] Record every number as observed in the PR body. State the coverage that
        was not run, such as Windows and macOS.

## Maintainer decisions needed first

- Scope approval for the target-bound contract change (MT-2).
- O1 (shared-server retirement rule) and O2 (slot ownership).
