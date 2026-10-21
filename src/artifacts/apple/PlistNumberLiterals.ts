import {
  createPlistNumberCollector,
  type PlistNumberLiterals,
} from "../../domain/apple/plistNumbers.js";
import { hasBinaryPlistSignature } from "../../domain/apple/appleArchiveFormat.js";
import { binaryPlistDateRepresentable } from "./BinaryPlistDate.js";

export interface BinaryPlistNumberMetadata {
  readonly literals: PlistNumberLiterals;
  /** 16-byte integers the pinned plist decoder cannot decode correctly. */
  readonly wideIntegers: readonly {
    offset: number;
    value: bigint;
    /** Another table entry points inside the bytes an in-place rewrite touches. */
    conflicted: boolean;
  }[];
}

const binaryObjectEnd = (
  bytes: Buffer,
  offset: number,
  objectEnd: number,
  referenceWidth: number,
): number | undefined => {
  const marker = bytes[offset];
  if (marker === undefined) return undefined;
  const type = marker >> 4;
  let length = marker & 0x0f;
  let cursor = offset + 1;
  if (length === 0x0f && type !== 0 && type !== 8) {
    const extendedMarker = bytes[cursor];
    if (extendedMarker === undefined || extendedMarker >> 4 !== 1)
      return undefined;
    const width = 1 << (extendedMarker & 0x0f);
    if (width > 8 || cursor + 1 + width > objectEnd) return undefined;
    cursor += 1;
    let extendedLength = 0n;
    for (let index = 0; index < width; index += 1)
      extendedLength =
        (extendedLength << 8n) | BigInt(bytes[cursor + index] ?? 0);
    if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    length = Number(extendedLength);
    cursor += width;
  }
  let payloadLength: number;
  if (type === 0) payloadLength = 0;
  else if (type === 1 || type === 2) {
    if ((marker & 0x0f) > 4) return undefined;
    payloadLength = 1 << (marker & 0x0f);
  } else if (type === 3) {
    if (marker !== 0x33) return undefined;
    payloadLength = 8;
  } else if (type === 4 || type === 5 || type === 7) {
    payloadLength = length;
  } else if (type === 6) {
    payloadLength = length * 2;
  } else if (type === 8) {
    payloadLength = (marker & 0x0f) + 1;
  } else if (type === 10 || type === 11 || type === 12) {
    payloadLength = length * referenceWidth;
  } else if (type === 13) {
    payloadLength = length * 2 * referenceWidth;
  } else return undefined;
  const end = cursor + payloadLength;
  return Number.isSafeInteger(end) && end <= objectEnd ? end : undefined;
};

/** Observe bounded binary number markers without changing primary decode acceptance. */
export const scanBinaryPlistNumberLiterals = (
  bytes: Buffer,
): BinaryPlistNumberMetadata => {
  const output = createPlistNumberCollector();
  const wideIntegers: {
    offset: number;
    value: bigint;
    conflicted: boolean;
  }[] = [];
  if (bytes.length < 40 || !hasBinaryPlistSignature(bytes))
    return { literals: output.result(true), wideIntegers };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetWidth = bytes[trailer + 6] ?? 0;
  if (![1, 2, 4, 8].includes(offsetWidth))
    return { literals: output.result(true), wideIntegers };
  const countRaw = view.getBigUint64(trailer + 8);
  const tableRaw = view.getBigUint64(trailer + 24);
  const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (countRaw === 0n || countRaw > safeMaximum || tableRaw > safeMaximum)
    return { literals: output.result(true), wideIntegers };
  if (tableRaw < 8n || tableRaw >= BigInt(trailer))
    return { literals: output.result(true), wideIntegers };
  const offsetTable = Number(tableRaw);
  const capacity = Math.floor((trailer - offsetTable) / offsetWidth);
  if (countRaw > BigInt(capacity))
    return { literals: output.result(true), wideIntegers };
  const count = Number(countRaw);
  const referenceWidth = bytes[trailer + 7] ?? 0;
  if (![1, 2, 4, 8].includes(referenceWidth))
    return { literals: output.result(true), wideIntegers };
  const unsigned = (offset: number): number | undefined => {
    if (offset < offsetTable || offset + offsetWidth > trailer)
      return undefined;
    if (offsetWidth === 1) return view.getUint8(offset);
    if (offsetWidth === 2) return view.getUint16(offset);
    if (offsetWidth === 4) return view.getUint32(offset);
    const value = view.getBigUint64(offset);
    return value > safeMaximum ? undefined : Number(value);
  };
  const objectOffsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = unsigned(offsetTable + index * offsetWidth);
    if (offset === undefined || offset < 8 || offset >= offsetTable)
      return { literals: output.result(true), wideIntegers };
    objectOffsets.push(offset);
  }
  // A table entry may legally alias bytes inside another object's payload;
  // plutil and Python accept the overlap. Validate each object against the
  // offset table itself and skip an alias for number metadata instead of
  // dropping every observed literal.
  const containedOffsets = new Set<number>();
  let coveredUntil = -1;
  for (const offset of [...new Set(objectOffsets)].sort((a, b) => a - b)) {
    if (offset < coveredUntil) {
      containedOffsets.add(offset);
      continue;
    }
    const end = binaryObjectEnd(bytes, offset, offsetTable, referenceWidth);
    if (end === undefined)
      return { literals: output.result(true), wideIntegers: [] };
    coveredUntil = end;
  }
  const offsetSet = new Set(objectOffsets);
  for (const offset of objectOffsets) {
    if (containedOffsets.has(offset)) continue;
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (type !== 1 && type !== 2) continue;
    const width = 2 ** (marker & 0xf);
    if (offset + 1 + width > offsetTable)
      return { literals: output.result(true), wideIntegers };
    if (type === 1 && width === 8) output.integer(view.getBigInt64(offset + 1));
    else if (type === 1 && width === 16) {
      const value = BigInt.asIntN(
        128,
        (view.getBigUint64(offset + 1) << 64n) | view.getBigUint64(offset + 9),
      );
      output.integer(value);
      // An in-place rewrite touches the marker plus eight payload bytes; an
      // alias inside that range would decode from rewritten bytes, so the
      // archive reader restores a conflicted integer from its exact value.
      let conflicted = false;
      for (let distance = 1; distance < 9; distance += 1)
        if (offsetSet.has(offset + distance)) {
          conflicted = true;
          break;
        }
      wideIntegers.push({ offset, value, conflicted });
    } else if (type === 1 && width > 4)
      return { literals: output.result(true), wideIntegers };
    else if (type === 2 && width === 4)
      output.real(view.getFloat32(offset + 1));
    else if (type === 2 && width === 8)
      output.real(view.getFloat64(offset + 1));
    else if (type === 2) return { literals: output.result(true), wideIntegers };
  }
  return { literals: output.result(containedOffsets.size > 0), wideIntegers };
};

/**
 * Preserve 16-byte integers and unrepresentable dates through plist@5.
 * Both rewrites share one decoder-input copy. The caller's buffer stays
 * unchanged, and it is returned when neither rewrite is needed.
 * Date seconds are read from the original bytes before any rewrite.
 */
export const decodeBinaryPlistNumbers = (
  bytes: Buffer,
  metadata: BinaryPlistNumberMetadata,
  datePayloadOffsets: readonly number[] = [],
): Buffer => {
  const unrepresentableDates: number[] = [];
  for (const offset of datePayloadOffsets) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + 8 > bytes.length
    )
      throw new TypeError("binary plist date object is truncated");
    if (!binaryPlistDateRepresentable(bytes.readDoubleBE(offset)))
      unrepresentableDates.push(offset);
  }
  const patchable = metadata.wideIntegers.filter((entry) => !entry.conflicted);
  if (patchable.length === 0 && unrepresentableDates.length === 0) return bytes;
  const compatible = Buffer.from(bytes);
  for (const { offset, value } of patchable) {
    // Convert only the decoder's input copy to a double. Exact integer metadata
    // from the original bytes restores decimal text after the structural parse.
    compatible[offset] = 0x23;
    compatible.writeDoubleBE(Number(value), offset + 1);
  }
  for (const offset of unrepresentableDates)
    compatible.writeDoubleBE(Number.NaN, offset);
  return compatible;
};
