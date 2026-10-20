import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  environmentServeSource,
  environmentStateServeFixture,
} from "../../../tests/fixtures/environmentServe.js";
import {
  BOOK_NOT_FOUND,
  BOOK_ROWS,
  book,
  renamedBook,
} from "../../../tests/fixtures/environmentStateWrites.js";
import { compareEnvironment } from "./environmentCompare.js";
import { matchProbeRequest } from "./environmentCompareMatch.js";

const fixture = environmentStateServeFixture(timedCaptureEvidence(BOOK_ROWS));
const source = environmentServeSource(fixture);

/** The books application re-seeded: the same books under other ids and creation times. */
const LIVE_FIRST = book(101, "First Book", "2026-10-20T09:00:00Z");
const LIVE_SECOND = book(102, "Second Book", "2026-10-20T10:00:00Z");
const LIVE_FOURTH = book(103, "Fourth Book", "2026-10-20T11:00:00Z");
const LIVE_RENAMED = renamedBook(LIVE_FIRST, "Renamed Book", 5);

const compare = (...probes: (readonly TimedCaptureRow[])[]) => {
  const report = compareEnvironment({
    source,
    captureValue: fixture.capture,
    probes: probes.map((rows, index) => ({
      label: `probe-${String(index + 1)}`,
      value: timedCaptureEvidence(rows),
    })),
    operation: "environment-compare",
  });
  if (!report.ok) throw report.error;
  return report.value;
};

describe("matchProbeRequest", () => {
  it("prefers literal segments, requires format-rule parameters to fit, and maps query and body arguments", () => {
    const item = matchProbeRequest(source.manifest, {
      method: "GET",
      path: "/api/books/7",
      query: "?expand=all",
      body: undefined,
    });
    expect(item?.tool.path_template).toBe("/api/books/{numeric}");
    expect(item?.args).toEqual({ id: "7" });
    expect(item?.ignoredQuery).toEqual(["expand"]);
    const create = matchProbeRequest(source.manifest, {
      method: "POST",
      path: "/api/books",
      query: null,
      body: { name: "X" },
    });
    expect(create?.args).toEqual({ body: { name: "X" } });
    expect(
      matchProbeRequest(source.manifest, {
        method: "GET",
        path: "/api/books/x",
        query: null,
        body: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("compareEnvironment", () => {
  it("agrees with a re-seeded application once seeded and created ids are mapped", () => {
    const report = compare([
      ["GET", "/api/books", [LIVE_FIRST, LIVE_SECOND]],
      ["GET", "/api/books/101", LIVE_FIRST],
      ["POST", "/api/books", LIVE_FOURTH, 201, { name: "Fourth Book" }],
      ["GET", "/api/books/103", LIVE_FOURTH],
      ["PATCH", "/api/books/101", LIVE_RENAMED, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/101", LIVE_RENAMED],
      ["DELETE", "/api/books/103", "", 204],
      ["GET", "/api/books/103", BOOK_NOT_FOUND, 404],
      ["GET", "/api/books", [LIVE_RENAMED, LIVE_SECOND]],
    ]);
    expect(report.environment.state).toBe("served");
    expect(report.probes[0]?.results.filter((step) => !step.equal)).toEqual([]);
    expect(report.summary).toMatchObject({
      probes: 1,
      steps: 9,
      equal: 9,
      agreement: 1,
    });
    expect(report.probes[0]?.ids_mapped).toBe(3);
    expect(report.summary.normalised.ids).toBeGreaterThan(0);
  });

  it("resets the state per probe and categorises every kind of disagreement", () => {
    const report = compare(
      [
        ["GET", "/api/books", [LIVE_FIRST, LIVE_SECOND]],
        ["DELETE", "/api/books/101", { detail: "Book is referenced." }, 409],
        ["GET", "/api/authors", []],
        ["GET", "/api/books/555", LIVE_FIRST],
      ],
      [["GET", "/api/books", [LIVE_SECOND, LIVE_FIRST, LIVE_FOURTH]]],
    );
    const [first, second] = report.probes;
    expect(first?.results.map((step) => step.categories)).toEqual([
      [],
      ["status", "value"],
      ["no-tool"],
      ["unmapped-id", "status", "missing-field", "extra-field"],
    ]);
    expect(second?.results[0]?.categories).toEqual(["length", "order"]);
    expect(report.summary.categories).toMatchObject({
      status: 2,
      "no-tool": 1,
      "unmapped-id": 1,
      length: 1,
      order: 1,
    });
    expect(report.tools.map((tool) => tool.tool)).toContain(
      "delete_books_by_id",
    );
  });
});
