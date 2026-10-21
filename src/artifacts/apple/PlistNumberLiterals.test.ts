import { describe, expect, it } from "vitest";

import {
  decodeBinaryPlistNumbers,
  scanBinaryPlistNumberLiterals,
} from "./PlistNumberLiterals.js";

const dataObjectWithUnusedOverlappingInteger = (): Buffer => {
  const bytes = Buffer.alloc(66);
  Buffer.from("bplist00", "ascii").copy(bytes);
  bytes[8] = 0xa1; // One-element array referencing data object 1.
  bytes[9] = 1;
  bytes[10] = 0x4f; // Data object with an extended length of 18 bytes.
  bytes[11] = 0x10;
  bytes[12] = 18;
  bytes[13] = 0x14; // An unused object-table entry points into this data.
  bytes.fill(0xff, 14, 30);
  bytes[30] = 0;
  bytes.set([8, 10, 13], 31); // object offsets, including the overlapping entry
  bytes[40] = 1; // offset width
  bytes[41] = 1; // reference width
  bytes.writeBigUInt64BE(3n, 42);
  bytes.writeBigUInt64BE(0n, 50);
  bytes.writeBigUInt64BE(31n, 58);
  return bytes;
};

describe("binary plist number rewriting", () => {
  it("does not rewrite an integer marker inside another object's data", () => {
    const bytes = dataObjectWithUnusedOverlappingInteger();
    const metadata = scanBinaryPlistNumberLiterals(bytes);

    expect(metadata.literals.incomplete).toBe(true);
    expect(metadata.wideIntegers).toEqual([]);
    expect(metadata.unrepresentableDateOffsets).toEqual([]);
    expect(decodeBinaryPlistNumbers(bytes, metadata)).toBe(bytes);
    expect(bytes.subarray(13, 30)).toEqual(
      Buffer.from([0x14, ...Array<number>(16).fill(0xff)]),
    );
  });

  it("identifies binary dates with sub-millisecond precision and rewrites them to NaN", () => {
    const header = Buffer.from("bplist00", "ascii");
    // Date object 1: marker 0x33, followed by 8 bytes float64
    const date1 = Buffer.alloc(9);
    date1[0] = 0x33;
    date1.writeDoubleBE(0.1, 1); // 100ms exact

    const date2 = Buffer.alloc(9);
    date2[0] = 0x33;
    date2.writeDoubleBE(0.1005, 1); // 100.5ms sub-ms

    // Array containing reference 0 and 1
    const array = Buffer.from([0xa2, 0, 1]);

    const offset0 = 8;
    const offset1 = offset0 + array.length;
    const offset2 = offset1 + date1.length;
    const offsetTable = offset2 + date2.length;

    const table = Buffer.from([offset0, offset1, offset2]);
    const trailer = Buffer.alloc(32);
    trailer[6] = 1; // offset width
    trailer[7] = 1; // reference width
    trailer.writeBigUInt64BE(3n, 8); // 3 objects
    trailer.writeBigUInt64BE(0n, 16); // top object 0
    trailer.writeBigUInt64BE(BigInt(offsetTable), 24);

    const bytes = Buffer.concat([header, array, date1, date2, table, trailer]);
    const metadata = scanBinaryPlistNumberLiterals(bytes);

    expect(metadata.unrepresentableDateOffsets).toEqual([offset2]);

    const rewritten = decodeBinaryPlistNumbers(bytes, metadata);
    expect(rewritten).not.toBe(bytes);
    expect(rewritten.readDoubleBE(offset1 + 1)).toBe(0.1);
    expect(Number.isNaN(rewritten.readDoubleBE(offset2 + 1))).toBe(true);
  });
});
