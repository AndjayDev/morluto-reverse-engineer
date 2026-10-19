import { describe, expect, it, vi } from "vitest";

import { isJarManifestName, isMultiReleaseManifest } from "./jarManifest.js";

const bytes = (text: string): Uint8Array => Buffer.from(text, "latin1");
const CRLF = "\r\n";
const MR = "Multi-Release: true";

/**
 * Each case is a crafted manifest whose expected verdict is what OpenJDK 25.0.4
 * `JarFile.isMultiRelease()` returned for a JAR holding it as
 * META-INF/MANIFEST.MF (audit corpus m0-m24; m4/m17 vary the stored name and
 * m16 omits the manifest, so they are covered by isJarManifestName).
 */
const JDK_VERDICTS: readonly (readonly [string, string, boolean])[] = [
  ["m0 plain", `Manifest-Version: 1.0${CRLF}${MR}${CRLF}${CRLF}`, true],
  // JDK: false. The value is "true " and Boolean.parseBoolean does not trim.
  [
    "m1 trailing space",
    `Manifest-Version: 1.0${CRLF}${MR} ${CRLF}${CRLF}`,
    false,
  ],
  // JDK: false. Attributes.read requires ": " and fails the whole section.
  [
    "m2 no space after colon",
    `Manifest-Version: 1.0${CRLF}Multi-Release:true${CRLF}${CRLF}`,
    false,
  ],
  // JDK: false. The parsed value is "true", but the byte pre-filter never sees
  // the contiguous `Multi-Release: true`.
  [
    "m3 value continuation",
    `Manifest-Version: 1.0${CRLF}Multi-Release: tr${CRLF} ue${CRLF}${CRLF}`,
    false,
  ],
  ["m5 CR-only newlines", `Manifest-Version: 1.0\r${MR}\r\r`, true],
  // JDK: false. The BOM makes the first name invalid, failing the section.
  ["m6 UTF-8 BOM", `ï»¿Manifest-Version: 1.0${CRLF}${MR}${CRLF}${CRLF}`, false],
  [
    "m7 mixed-case value",
    `Manifest-Version: 1.0${CRLF}Multi-Release: True${CRLF}${CRLF}`,
    true,
  ],
  // JDK: false. Only the main section is read.
  [
    "m8 named section only",
    `Manifest-Version: 1.0${CRLF}${CRLF}Name: p/A.class${CRLF}${MR}${CRLF}${CRLF}`,
    false,
  ],
  [
    "m9 attribute first",
    `${MR}${CRLF}Manifest-Version: 1.0${CRLF}${CRLF}`,
    true,
  ],
  // JDK: false. The text is part of Comment's continued value.
  [
    "m10 inside a continuation",
    `Manifest-Version: 1.0${CRLF}Comment: x${CRLF} ${MR}${CRLF}${CRLF}`,
    false,
  ],
  ["m11 LF-only newlines", `Manifest-Version: 1.0\n${MR}\n\n`, true],
  // JDK: false. An unterminated last line is dropped unread.
  ["m12 no newline after true", `Manifest-Version: 1.0${CRLF}${MR}`, false],
  [
    "m13 false",
    `Manifest-Version: 1.0${CRLF}Multi-Release: false${CRLF}${CRLF}`,
    false,
  ],
  // JDK: false. "Multi-Release " is not a valid attribute name.
  [
    "m21 padded name",
    `Manifest-Version: 1.0${CRLF}Multi-Release : true${CRLF}${CRLF}`,
    false,
  ],
  // JDK: true / false. Duplicate names replace earlier values; the last wins.
  [
    "m22 false then true",
    `Manifest-Version: 1.0${CRLF}Multi-Release: false${CRLF}${MR}${CRLF}${CRLF}`,
    true,
  ],
  [
    "m23 true then false",
    `Manifest-Version: 1.0${CRLF}${MR}${CRLF}Multi-Release: false${CRLF}${CRLF}`,
    false,
  ],
];

describe("isMultiReleaseManifest (OpenJDK 25 JarFile.isMultiRelease)", () => {
  it.each(JDK_VERDICTS)("%s", (_name, manifest, expected) => {
    expect(isMultiReleaseManifest(bytes(manifest))).toBe(expected);
  });

  it("fails the main section on any invalid header, as the JDK does", () => {
    // JDK: false (missing colon, misplaced continuation, 71-char name).
    expect(
      isMultiReleaseManifest(bytes(`${MR}${CRLF}NoColon${CRLF}${CRLF}`)),
    ).toBe(false);
    expect(isMultiReleaseManifest(bytes(` x${CRLF}${MR}${CRLF}${CRLF}`))).toBe(
      false,
    );
    expect(
      isMultiReleaseManifest(
        bytes(`${MR}${CRLF}${"X".repeat(71)}: v${CRLF}${CRLF}`),
      ),
    ).toBe(false);
    // JDK: true. An invalid header after the main section is never read.
    expect(
      isMultiReleaseManifest(bytes(`${MR}${CRLF}${CRLF}NoColon${CRLF}`)),
    ).toBe(true);
  });

  it("applies the JDK's 512-byte line buffer", () => {
    const pad = (n: number) => `P: ${"p".repeat(n - 3)}`;
    // JDK: true. 510 bytes + CRLF fits the buffer.
    expect(
      isMultiReleaseManifest(bytes(`${pad(510)}${CRLF}${MR}${CRLF}${CRLF}`)),
    ).toBe(true);
    // JDK: false. 511 bytes + CR fills it; the LF then reads as a blank line
    // that ends the main section before Multi-Release.
    expect(
      isMultiReleaseManifest(bytes(`${pad(511)}${CRLF}${MR}${CRLF}${CRLF}`)),
    ).toBe(false);
    // JDK: false. A 512-byte line has no terminator in the buffer ("line too long").
    expect(
      isMultiReleaseManifest(bytes(`${MR}${CRLF}${pad(512)}${CRLF}${CRLF}`)),
    ).toBe(false);
  });

  it("joins a CRLF split by the JDK's 8192-byte read boundary", () => {
    // JDK: true. The CR is byte 8191 and the LF byte 8192 of the stream; read
    // as two lines, the LF would end the main section before Multi-Release.
    const head = `Manifest-Version: 1.0${CRLF}`;
    let filler = "";
    while (head.length + filler.length + 500 < 8191)
      filler += `F: ${"f".repeat(480)}${CRLF}`;
    const last = `G: ${"g".repeat(8191 - head.length - filler.length - 3)}`;
    const manifest = `${head}${filler}${last}${CRLF}${MR}${CRLF}${CRLF}`;
    expect(manifest.indexOf(`${last}\r`) + last.length).toBe(8191);
    expect(isMultiReleaseManifest(bytes(manifest))).toBe(true);
  });
});

describe("isJarManifestName (OpenJDK 25 ZipFile manifest lookup)", () => {
  it("matches the stored name in any ASCII case", () => {
    expect(isJarManifestName("META-INF/MANIFEST.MF")).toBe(true);
    // m4: JDK multi-release true with the manifest stored in lowercase.
    expect(isJarManifestName("meta-inf/manifest.mf")).toBe(true);
    expect(isJarManifestName("Meta-Inf/Manifest.Mf")).toBe(true);
  });

  it("rejects respelled and look-alike names", () => {
    // m17: JDK multi-release false with the manifest stored as ./META-INF/MANIFEST.MF.
    expect(isJarManifestName("./META-INF/MANIFEST.MF")).toBe(false);
    expect(isJarManifestName("/META-INF/MANIFEST.MF")).toBe(false);
    expect(isJarManifestName("META-INF/MANIFEST.MF/")).toBe(false);
    expect(isJarManifestName("META_INF/MANIFEST.MF")).toBe(false);
    // U+0130 lowercases to "i̇" in Unicode; only ASCII case is folded.
    expect(isJarManifestName("META-İNF/MANIFEST.MF")).toBe(false);
  });
});

describe("isMultiReleaseManifest continuation cost", () => {
  it("decides a value continued over 300,000 lines without copying each line", () => {
    // OpenJDK 25.0.4 JarFile.isMultiRelease(): true. The value "tr" + 300,000
    // empty continuations + "ue" is "true"; the pre-filter matches X-Note.
    const manifest = bytes(
      `Manifest-Version: 1.0${CRLF}X-Note: ${MR}${CRLF}Multi-Release: tr${CRLF}` +
        ` ${CRLF}`.repeat(300_000) +
        ` ue${CRLF}${CRLF}`,
    );
    // Retaining one copy per continuation line grew the heap ~63 MiB here;
    // only the attribute names may be copied.
    const slice = vi.spyOn(Uint8Array.prototype, "slice");
    try {
      expect(isMultiReleaseManifest(manifest)).toBe(true);
      expect(slice.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      slice.mockRestore();
    }
  });
});
