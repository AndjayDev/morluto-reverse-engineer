# Answer list filters, search, sorting and paging from the state

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

Agents list, filter, search and sort constantly. A list view answered a recorded request line from the state only when
that line listed the whole collection; any other line, such as `?shelf=a`, `?q=tide` or `?orderBy=name`, kept the
members it recorded, and a call with a value no line recorded replayed whichever recording was closest. A filtered
list therefore never showed what a write created or changed, and a search for anything new answered with an
unrelated recording.

A list view now learns what each of its query parameters does, from the lines it recorded, and answers those lines,
and calls with new values, by evaluating the query over the live state.

## Learning

For each checked line that does not list the whole collection, the first combination of roles that lists exactly what
the line recorded, from the collection's initial entities, explains it:

- `filter` on a field every listed item holds the value in: equal as text, or in an array directly or as an object's
  `id`, `slug` or `name`;
- `search` over the string fields the term matched in the listed items, ignoring case (URL fields only for an item
  nothing else matched); an empty term matches everything;
- `sort` by the field the value names, with `-` or an `asc`/`desc` suffix, and `direction` for a separate `asc`/`desc`
  parameter: numbers by value, text ignoring case, null last ascending, ties in state order;
- `limit`, `offset` and `page` (counted from 1 or 0, whichever explains the line) for paging; zero or a negative limit
  lists every match;
- `inert` for a parameter that changes nothing, valid only for the values it recorded.

Parameter names decide which roles are tried (`sort` for `orderBy`, `search` for `q`), and any parameter may be a
filter or inert. The lines' roles merge: lines that disagree drop the parameter, inert values gather, search fields
unite. The merged query keeps the lines it reproduces, envelope and fields included; any other line keeps its
recorded members. The view's `query` names the roles, those lines, and the envelope members that count every match
before paging (`totals`); a `number`-of-items member such as `numberOfElements` counts the page.

## Serving and the write gate

- A call that names a query line exactly, or whose every query argument has a role (an argument-less call keeps
  answering on a whole line), is answered by evaluating the query over the state, in the envelope of a query or whole
  line of its collection, with counters at the number listed and totals at the number matched. The answer's state
  provenance says `membership: "query"`.
- A value an inert parameter never recorded, or a parameter without a role, replays its recording as before.
- The write gate checks a read on a query line against the query over its copy of the state. Only a line whose
  parameters all sort or page, and whose answer holds every match, covers the collection; any other covers the
  entities it lists and those the line or the read listed that the state no longer holds, so a filtered list shows
  whether a delete or create took effect without speaking for the rest of the collection.

The roles are inferences from recorded behaviour and are stated as such. Nothing changes for a list whose lines all
list the whole collection, or that no role explains.

## Acceptance

- Unit tests: each role found from a line, including filters on arrays and object ids, search ignoring URLs, sort
  spellings and nulls, paging by offset and by page, inert values; merging lines; values a role cannot apply.
- Domain: a tool recorded whole, filtered, searched, sorted and with a flag learns all four, and a create the filter
  later lists is confirmed.
- Serving: after a served create, new filter, search and sort values list it; an unrecorded inert value replays.
- Measured: the fifty published captures' learned queries and write verdicts, and the six environments compared with
  their applications, before and after.
