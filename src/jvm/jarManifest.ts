/**
 * The JDK's multi-release JAR decision (`java.util.jar.JarFile.isMultiRelease`
 * with the default `jdk.util.jar.enableMultiRelease=true`), reproduced
 * byte-for-byte so REA treats `META-INF/versions/` members exactly as the
 * runtime does. Verified against OpenJDK 25 (`JarFile.checkForSpecialAttributes`
 * and `match`, `ZipFile.Source.isMetaName`/`isManifestName`,
 * `Attributes.read`, `Manifest.FastInputStream`, `Attributes.Name`).
 *
 * A JAR is multi-release only when both hold:
 * 1. the ASCII-case-insensitive bytes `Multi-Release: true` occur anywhere in
 *    the manifest (the JDK's pre-filter scan), and
 * 2. `Attributes.read` parses the main section without error and the last
 *    `Multi-Release` value, untrimmed, equals `true` ignoring case
 *    (`Boolean.parseBoolean`). A parse error makes the JAR not multi-release.
 */

/**
 * `JarFile.getBytes` refuses a manifest whose declared size exceeds
 * `SignatureFileVerifier.MAX_SIG_FILE_SIZE` (the `jdk.jar.maxSignatureFileSize`
 * system property, default 16,000,000 bytes); `isMultiRelease()` then catches
 * that IOException and returns false, so a larger manifest is never honored.
 */
export const JDK_DEFAULT_MAX_MANIFEST_BYTES = 16_000_000;

/** The JDK locates the manifest by its stored name, ignoring ASCII case. */
const MANIFEST_NAME = "meta-inf/manifest.mf";

const asciiLower = (code: number): number =>
  code >= 0x41 && code <= 0x5a ? code | 0x20 : code;

/**
 * Whether a stored ZIP member name is the JAR manifest: exactly
 * `META-INF/MANIFEST.MF` in any ASCII case. A `./`-prefixed or otherwise
 * respelled name is not the manifest, and non-ASCII look-alikes never match.
 */
export const isJarManifestName = (storedName: string): boolean => {
  if (storedName.length !== MANIFEST_NAME.length) return false;
  for (let i = 0; i < MANIFEST_NAME.length; i++)
    if (asciiLower(storedName.charCodeAt(i)) !== MANIFEST_NAME.charCodeAt(i))
      return false;
  return true;
};

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const COLON = 0x3a;

// JarFile.MULTIRELEASE_CHARS and its precomputed Boyer-Moore shift tables.
const PATTERN = Uint8Array.from("MULTI-RELEASE: TRUE", (c) => c.charCodeAt(0));
const LAST_OCCURRENCE = new Uint8Array(65);
for (const [c, shift] of [
  ["M", 1],
  ["I", 5],
  ["-", 6],
  ["L", 9],
  ["A", 11],
  ["S", 12],
  [":", 14],
  [" ", 15],
  ["T", 16],
  ["R", 17],
  ["U", 18],
  ["E", 19],
] as const)
  LAST_OCCURRENCE[c.charCodeAt(0) - 32] = shift;
const GOOD_SUFFIX = Uint8Array.from({ length: 19 }, (_, j) =>
  j === 17 ? 6 : j === 18 ? 1 : 19,
);

/** `JarFile.match` for `MULTIRELEASE_CHARS`, including its skip rules. */
const containsMultiReleaseTrue = (b: Uint8Array): boolean => {
  const len = PATTERN.length;
  const last = b.length - len;
  let i = 0;
  next: while (i <= last) {
    for (let j = len - 1; j >= 0; j--) {
      let c = b[i + j]!;
      if (c >= 0x20 && c <= 0x7a) {
        if (c >= 0x61) c -= 32;
        if (c !== PATTERN[j]) {
          i += Math.max(j + 1 - LAST_OCCURRENCE[c - 32]!, GOOD_SUFFIX[j]!);
          continue next;
        }
      } else {
        i += len;
        continue next;
      }
    }
    return true;
  }
  return false;
};

/** `Manifest.FastInputStream` over a byte array read in 8192-byte fills. */
class ManifestLineReader {
  static readonly #fillBytes = 8192;
  #pos = 0;
  #count = 0;

  constructor(private readonly bytes: Uint8Array) {}

  #fill(): void {
    this.#count = Math.min(
      this.#pos + ManifestLineReader.#fillBytes,
      this.bytes.length,
    );
  }

  /** `readLine(byte[])`: -1 at EOF, else the bytes copied into `line`. */
  readLine(line: Uint8Array): number {
    const buf = this.bytes;
    const len = line.length;
    let off = 0;
    let total = 0;
    while (total < len) {
      let avail = this.#count - this.#pos;
      if (avail <= 0) {
        this.#fill();
        avail = this.#count - this.#pos;
        // An unterminated final line is dropped, as the JDK drops it.
        if (avail <= 0) return -1;
      }
      const maxpos = this.#pos + Math.min(len - total, avail);
      let tpos = this.#pos;
      let c = 0;
      while (tpos < maxpos) {
        c = buf[tpos++]!;
        if (c === LF || c === CR) break;
      }
      if (c === CR && tpos < maxpos && buf[tpos] === LF) tpos++;
      line.set(buf.subarray(this.#pos, tpos), off);
      off += tpos - this.#pos;
      total += tpos - this.#pos;
      this.#pos = tpos;
      c = buf[tpos - 1]!;
      if (c === LF) break;
      if (c === CR) {
        if (this.#count === this.#pos) {
          this.#fill();
          if (this.#pos < this.#count && buf[this.#pos] === LF) {
            if (total < len) {
              line[off++] = LF;
              total++;
            } else line[off - 1] = LF;
            this.#pos++;
          }
        }
        break;
      }
    }
    return total;
  }

  peek(): number {
    if (this.#pos === this.#count) this.#fill();
    return this.#pos === this.#count ? -1 : this.bytes[this.#pos]!;
  }
}

/** `Attributes.Name`: 1-70 characters from `[A-Za-z0-9_-]`. */
const isValidAttributeName = (name: Uint8Array): boolean =>
  name.length >= 1 &&
  name.length <= 70 &&
  name.every(
    (c) =>
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x5f ||
      c === 0x2d,
  );

const asciiEqualsIgnoreCase = (bytes: Uint8Array, lower: string): boolean =>
  bytes.length === lower.length &&
  bytes.every((c, i) => asciiLower(c) === lower.charCodeAt(i));

/**
 * Whether a value, fed in fragments as its continuation lines arrive, equals
 * `true` ignoring ASCII case. Only the match state is kept, never the value:
 * a value continued over any number of lines costs constant memory.
 */
class TrueValueMatcher {
  #matched = 0;
  #possible = true;

  /** Match `bytes[from, to)`; reads in place, allocating nothing. */
  feed(bytes: Uint8Array, from: number, to: number): void {
    for (let at = from; at < to; at++) {
      const byte = bytes[at]!;
      if (
        !this.#possible ||
        this.#matched >= 4 ||
        asciiLower(byte) !== "true".charCodeAt(this.#matched)
      ) {
        this.#possible = false;
        return;
      }
      this.#matched++;
    }
  }

  get isTrue(): boolean {
    return this.#possible && this.#matched === 4;
  }
}

/**
 * `Attributes.read` over the main section with the JDK's 512-byte line
 * buffer, reduced to the one fact needed: whether the last `Multi-Release`
 * value is `true`. `undefined` is a parse failure (the JDK's IOException).
 */
const mainSectionMultiRelease = (bytes: Uint8Array): boolean | undefined => {
  const reader = new ManifestLineReader(bytes);
  const line = new Uint8Array(512);
  let name: Uint8Array | undefined;
  // The value being assembled for `name`, matched as it arrives.
  let value: TrueValueMatcher | undefined;
  let multiRelease = false;
  for (;;) {
    let len = reader.readLine(line);
    if (len === -1) break;
    const terminator = line[--len];
    // A line filling the 512-byte buffer without a terminator ("line too long").
    if (terminator !== LF && terminator !== CR) return undefined;
    if (len > 0 && line[len - 1] === CR) len--;
    if (len === 0) break; // end of the main section
    if (line[0] === SPACE) {
      if (name === undefined) return undefined; // misplaced continuation
      value?.feed(line, 1, len);
      if (reader.peek() === SPACE) continue;
    } else {
      let i = 0;
      for (;;) {
        if (line[i++] === COLON) break;
        if (i >= len) return undefined; // no colon
      }
      if (line[i++] !== SPACE) return undefined; // no space after the colon
      name = line.slice(0, i - 2);
      value = asciiEqualsIgnoreCase(name, "multi-release")
        ? new TrueValueMatcher()
        : undefined;
      value?.feed(line, i, len);
      if (reader.peek() === SPACE) continue;
    }
    if (!isValidAttributeName(name)) return undefined;
    // Duplicate names replace earlier values: the last one wins.
    if (value !== undefined) multiRelease = value.isTrue;
  }
  return multiRelease;
};

/**
 * Whether the JDK treats a JAR with this manifest as multi-release. Outside a
 * multi-release JAR, `META-INF/versions/` entries are inert resources the
 * runtime never loads.
 */
export const isMultiReleaseManifest = (bytes: Uint8Array): boolean =>
  containsMultiReleaseTrue(bytes) && mainSectionMultiRelease(bytes) === true;
