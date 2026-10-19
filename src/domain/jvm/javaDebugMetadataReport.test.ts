import { describe, expect, it } from "vitest";

import { normalizeJarEntryPath } from "./javaDebugMetadataReport.js";

describe("normalizeJarEntryPath", () => {
  it("applies the ZIP reader's logical-path rule to the request", () => {
    expect(normalizeJarEntryPath("./Foo.class")).toBe("Foo.class");
    expect(normalizeJarEntryPath("././a/Foo.class")).toBe("a/Foo.class");
    expect(normalizeJarEntryPath("/a\\Foo.class")).toBe("a/Foo.class");
    expect(normalizeJarEntryPath("a/./Foo.class")).toBe("a/./Foo.class");
  });
});
