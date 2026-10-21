import { build, buildBinary } from "plist";
import { expect, it } from "vitest";

import { decodeKeyedArchiveBytes } from "../../../src/artifacts/apple/KeyedArchiveReader.js";

it.each([
  { name: "data", value: new Uint8Array([0]) },
  { name: "date", value: new Date(0) },
  { name: "real", value: Number.POSITIVE_INFINITY },
])(
  "rejects a $name scalar used as the top-level root dictionary in either encoding",
  ({ value }) => {
    const archive = {
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: ["$null"],
      $top: value,
    };
    for (const encode of [build, buildBinary]) {
      const bytes = Buffer.from(encode(archive));
      expect(() =>
        decodeKeyedArchiveBytes(bytes, { offset: 0, limit: 10 }),
      ).toThrow("Keyed archive has no $top roots");
    }
  },
);

it("keeps literal wrapper-shaped dictionaries as real root maps", () => {
  const top = { $plist_type: "data", base64: "AA==" };
  const archive = {
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: ["$null"],
    $top: top,
  };
  for (const encode of [build, buildBinary]) {
    const graph = decodeKeyedArchiveBytes(Buffer.from(encode(archive)), {
      offset: 0,
      limit: 10,
    });
    expect(graph.roots).toEqual(top);
    expect(graph.references).toEqual([]);
  }
});

it("retains own binary dictionary facts when a prototype key changes the decoder prototype", () => {
  const object = Object.fromEntries([
    ["__proto__", { inherited: "not an own fact" }],
    ["payload", "retained"],
  ]);
  const graph = decodeKeyedArchiveBytes(
    Buffer.from(
      buildBinary({
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: ["$null", object],
        $top: { root: { UID: 1 } },
      }),
    ),
    { offset: 0, limit: 10 },
  );
  expect(graph.objects[1]).toMatchObject({
    kind: "dictionary",
    value: { payload: "retained" },
  });
  expect(graph.objects[1]?.value).toEqual({ payload: "retained" });
  expect(graph.limitations).toContainEqual(
    expect.stringContaining("__proto__"),
  );
});

it("preserves exact millisecond binary dates while reporting sub-millisecond dates as unknown with a limitation", () => {
  const archive = buildBinary({
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: [
      "$null",
      new Date("2001-01-01T00:00:00.100Z"),
      new Date("2001-01-01T00:00:00.100Z"),
    ],
    $top: { root1: { UID: 1 }, root2: { UID: 2 } },
  });

  const bytes = Buffer.from(archive);
  // Find the two 0x33 date markers
  const dateOffsets: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x33) dateOffsets.push(i);
  }
  expect(dateOffsets).toHaveLength(2);

  // Leave object 1 at 0.100s, rewrite object 2 to 0.1005s (sub-ms)
  bytes.writeDoubleBE(0.1005, dateOffsets[1]! + 1);

  const graph = decodeKeyedArchiveBytes(bytes, { offset: 0, limit: 10 });
  expect(graph.objects[1]).toMatchObject({
    id: 1,
    kind: "scalar",
    status: "observed",
    value: { $plist_type: "date", iso8601: "2001-01-01T00:00:00.100Z" },
  });
  expect(graph.objects[2]).toMatchObject({
    id: 2,
    kind: "scalar",
    status: "observed",
    value: { $plist_type: "date", iso8601: null },
  });
  expect(graph.limitations).toContainEqual(
    '1 date value(s) are reported as { "$plist_type": "date", "iso8601": null } because the decoder could not represent their timestamps.',
  );
});
