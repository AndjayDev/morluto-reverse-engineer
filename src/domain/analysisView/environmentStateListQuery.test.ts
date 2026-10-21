import { describe, expect, it } from "vitest";

import {
  evaluateQuery,
  explainLine,
  learnQuery,
  lineChoices,
  queryValues,
  type QueryLine,
} from "./environmentStateListQuery.js";
import type { JsonObject, StateEntity } from "./environmentStateRules.js";

const entity = (fields: JsonObject): StateEntity => ({
  type: "/api/books",
  collection: "/api/books",
  id: String(fields["id"]),
  fields,
  view_fields: [],
  record_ordinals: [],
});

const BOOKS = [
  {
    id: 1,
    name: "Tide Tables",
    shelf: "a",
    tags: ["sea"],
    url: "https://x/tide",
  },
  { id: 2, name: "Lamp Oil", shelf: "b", tags: [{ id: "t1", name: "oil" }] },
  { id: 3, name: "tidewater", shelf: "a", tags: [], url: "https://x/other" },
  {
    id: 4,
    name: "Kelp",
    shelf: null,
    tags: ["sea"],
    url: "https://x/kelp-tide",
  },
].map((book) => entity({ ...book, active: true }));

/** A line as the gate reads it: its query, and the books it listed in order. */
const line = (
  query: string,
  listed: readonly number[],
  ordinal = 0,
): QueryLine => {
  const values = queryValues(query)!;
  const items = listed.map(
    (id) => BOOKS.find((book) => book.id === String(id))!.fields,
  );
  return {
    ordinal,
    values,
    listed: listed.map(String),
    choices: lineChoices(values, items),
    entities: BOOKS,
  };
};

const ids = (query: string, parameters: Parameters<typeof evaluateQuery>[0]) =>
  evaluateQuery(parameters, queryValues(query)!, BOOKS)?.page.map(
    (book) => book.id,
  );

describe("explaining a recorded line", () => {
  it("finds a filter on the field every listed item holds, scalar or in an array", () => {
    expect(explainLine(line("?shelf=a", [1, 3]))).toEqual({
      shelf: { role: "filter", field: "shelf" },
    });
    expect(explainLine(line("?tag=sea", [1, 4]))).toEqual({
      tag: { role: "filter", field: "tags" },
    });
    expect(explainLine(line("?tag=t1", [2]))).toEqual({
      tag: { role: "filter", field: "tags" },
    });
  });

  it("searches the fields the term matched, ignoring case, and leaves out URLs that merely repeat it", () => {
    expect(explainLine(line("?q=TIDE", [1, 3]))).toEqual({
      q: { role: "search", fields: ["name"] },
    });
  });

  it("sorts by the field a value names, with a direction parameter, prefix or suffix", () => {
    expect(
      explainLine(line("?orderBy=name&orderDirection=desc", [3, 1, 2, 4])),
    ).toEqual({
      orderBy: { role: "sort" },
      orderDirection: { role: "direction" },
    });
    expect(ids("?sort=-name", { sort: { role: "sort" } })).toEqual([
      "3",
      "1",
      "2",
      "4",
    ]);
    expect(ids("?sort=NAME-asc", { sort: { role: "sort" } })).toEqual([
      "4",
      "2",
      "1",
      "3",
    ]);
    // Null values sort last ascending.
    expect(ids("?sort=shelf", { sort: { role: "sort" } })).toEqual([
      "1",
      "3",
      "2",
      "4",
    ]);
  });

  it("pages by limit and offset, or by page number from the first page it explains", () => {
    expect(explainLine(line("?limit=2&offset=1", [2, 3]))).toEqual({
      limit: { role: "limit" },
      offset: { role: "offset" },
    });
    expect(explainLine(line("?page=2&per_page=2", [3, 4]))).toEqual({
      page: { role: "page", first: 1 },
      per_page: { role: "limit" },
    });
    expect(ids("?per_page=-1", { per_page: { role: "limit" } })).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("takes a parameter that changes nothing as inert, for its recorded values only", () => {
    const explained = explainLine(line("?includeDeleted=true", [1, 2, 3, 4]));
    expect(explained).toEqual({
      includeDeleted: { role: "inert", values: ["true"] },
    });
    expect(ids("?includeDeleted=false", explained!)).toBeUndefined();
  });

  it("keeps a filter that excludes nothing inert, as a flag", () => {
    expect(explainLine(line("?active=true", [1, 2, 3, 4]))).toEqual({
      active: { role: "inert", values: ["true"] },
    });
  });

  it("explains nothing that the collection cannot reproduce", () => {
    expect(explainLine(line("?shelf=a", [3, 1]))).toBeUndefined();
  });
});

describe("learning a list's query", () => {
  it("joins lines into one role per parameter and answers the lines it reproduces", () => {
    const learned = learnQuery([
      line("?shelf=a", [1, 3], 10),
      line("?shelf=b", [2], 11),
      line("?q=kelp", [4], 12),
      line("?q=oil", [2], 13),
    ]);
    expect(learned).toEqual({
      parameters: {
        shelf: { role: "filter", field: "shelf" },
        q: { role: "search", fields: ["name"] },
      },
      record_ordinals: [10, 11, 12, 13],
    });
    // A value no line recorded is evaluated the same way.
    expect(ids("?q=TIDE&shelf=a", learned!.parameters)).toEqual(["1", "3"]);
  });

  it("refuses a value a parameter cannot apply, or a parameter it never learned", () => {
    const parameters = { limit: { role: "limit" } } as const;
    expect(ids("?limit=two", parameters)).toBeUndefined();
    expect(ids("?shelf=a", parameters)).toBeUndefined();
    expect(queryValues("?a=1&a=2")).toBeUndefined();
  });
});
