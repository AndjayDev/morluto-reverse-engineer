# Verification

Verified commit: 6db41d29 (this branch before this file, with #5787 and the write-plan branch's head `fe8ab584` merged in). Executed on macOS with Node v22.23.1 (the repository pins 24.18.0 in `.nvmrc`, which was
not installed); the probes were recorded against the live applications on six disposable Linux VMs.

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint), `npm run format:check`, `npx knip`,
  `npm run scan:todos`, `npm run docs:check`, `npm run verify:test-discovery` and `npm run mcp-catalog:check`: passed.
- `npm run jscpd`: 3.44% duplicated lines over 3650 files, under the 3.5% gate.
- `npx vitest run --project domain --project services`: 7630 passed, 5 pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the environment serve and export CLI boundaries, the serve
  and served-writes MCP boundaries, the analysis-view CLI and MCP boundaries, the compact input schema boundary and
  tool schema validity: 8 files, 78 passed.

New tests: `environmentStateListQuery` (9 unit tests: each role found from a line, including filters on arrays and
object ids, search that leaves out URLs, sort spellings and nulls, paging by offset and by page, inert values, a filter
that excludes nothing kept inert, merging lines and refusals), one domain test in `environmentStateWrites` (a tool
recorded whole, filtered, searched, sorted and with a flag learns all four, and a create the filter later lists is
confirmed) and one serving test in `environmentStateWriteAnswer` (after a served create, new filter, search and sort
values list it; an unrecorded inert value replays).

## Fifty published captures

The environment-state view ran over the 50 published captures with each manifest's template rules, on builds with and
without this change (both with the prefix-variance branch merged, which some manifests need).

- 161 list views in 37 environments learn a query, and 223 checked lines are now answered by evaluating it. Roles
  learned: 27 filters, 37 searches, 35 sorts, 26 directions, 66 limits, 32 offsets, 25 page parameters and 220 inert
  parameters (each valid only for its recorded values).
- No other view changed shape and every write verdict is unchanged (31 served write tools).

## Six environments against their applications

The six environments of the fidelity comparison (NetBox, Komga, Mealie, n8n, Shlink, self-hosted Sentry) were compared
with their applications by `environment-compare`, with and without this change, on the comparison's probes and the
held-out sessions recorded since: NetBox 98.5%, Komga 91.5%, Mealie 94.0%, n8n 71.6%, Shlink 87.1% and Sentry 24.5%,
unchanged. Those probes repeat the capture's own query values, which recorded members already answer, so they cannot
show this change.

New held-out probes were therefore recorded against Komga and Mealie, the two applications whose list views learned
queries a new value can exercise, each restored from its snapshot first. After the capture's read-only prefix (so the
driver learns the application's ids), each learned query was called with values no recording used: other search terms
and filter values drawn from the seeded entities, the other sort direction, a page size of 1 and the second page.

| Application | Query calls | Exact before | Exact after | Right entities in the right order, before | After |
| ----------- | ----------: | -----------: | ----------: | ----------------------------------------: | ----: |
| Mealie      |          38 |            2 |          17 |                                         2 |    38 |
| Komga       |           9 |            0 |           0 |                                         0 |     8 |

Every Mealie call now lists the entities the application lists, in its order, where 36 of them listed the recorded
members before: sorts in the other direction (9) and new recipe searches and category filters (6) now match exactly.
The calls that still differ, and 8 of Komga's 9, differ only in paging members of the envelope: `per_page`, `page`,
`total_pages` and `next`/`previous` (Komga's `pageable` and `totalPages`) keep the base line's values when a call asks
for another page size or page. One Komga search term matched more series than the learned `name`/`url` fields, since
Komga also searches fields the list does not show. Over the whole probe Mealie went from 133 to 148 of 171 steps.

## What a run found

The first census learned Komga's `unpaged=false` as a filter on a field that is false for every entity, so `true` would
have emptied the list. A filter that excludes nothing is now inert, and a parameter filters only where a line shows it
excluding something: 37 of the census's 64 filters became inert values this way. A `-name` sort value matched the field loosely before its sign was read, so it sorted ascending;
the sign is now read first.
