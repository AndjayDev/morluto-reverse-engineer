import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

const writeTree = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

describe.skipIf(process.platform === "win32")(
  "nested reference ignore rules",
  () => {
    it("scopes anchored rules and negations to their directory and descendants", async () => {
      const root = await createTestTempDirectory(
        "rea-reference-nested-ignore-",
      );
      await writeTree(root, {
        ".gitignore": "*.tmp\n",
        "root.tmp": "root rule\n",
        "packages/[widget]/.gitignore": "!*.tmp\n/anchored.tmp\n",
        "packages/[widget]/keep.tmp": "child negation\n",
        "packages/[widget]/anchored.tmp": "child anchored rule\n",
        "packages/[widget]/deep/.gitignore": "again.tmp\n",
        "packages/[widget]/deep/anchored.tmp": "outside anchored rule\n",
        "packages/[widget]/deep/keep.tmp": "inherited negation\n",
        "packages/[widget]/deep/again.tmp": "deeper rule\n",
        "packages/sibling/keep.tmp": "root rule still applies\n",
        "packages/sibling/source.js": "export {};\n",
      });

      const result = await importReferenceSource({
        root,
        caller: "nested-ignore-test",
        policy: { secretPatterns: [] },
      });
      if (!result.ok) throw result.error;
      expect(result.value.exclusions).toEqual([
        {
          path: "packages/[widget]/anchored.tmp",
          entry_kind: "file",
          reason: "project-ignored",
          pattern: "/anchored.tmp",
        },
        {
          path: "packages/[widget]/deep/again.tmp",
          entry_kind: "file",
          reason: "project-ignored",
          pattern: "again.tmp",
        },
        {
          path: "packages/sibling/keep.tmp",
          entry_kind: "file",
          reason: "project-ignored",
          pattern: "*.tmp",
        },
        {
          path: "root.tmp",
          entry_kind: "file",
          reason: "project-ignored",
          pattern: "*.tmp",
        },
      ]);
      expect(
        result.value.entries
          .filter(({ kind }) => kind === "file")
          .map(({ path }) => path),
      ).toEqual([
        ".gitignore",
        "packages/[widget]/.gitignore",
        "packages/[widget]/deep/.gitignore",
        "packages/[widget]/deep/anchored.tmp",
        "packages/[widget]/deep/keep.tmp",
        "packages/[widget]/keep.tmp",
        "packages/sibling/source.js",
      ]);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "nested reference ignore syntax",
  () => {
    it.each(["a?b", "a*b", "a\\", "[widget]"])(
      "treats the policy directory %s as a literal path",
      async (directory) => {
        const root = await createTestTempDirectory(
          "rea-reference-ignore-literal-",
        );
        await writeTree(root, {
          [`${directory}/.gitignore`]: "ignored.txt\n",
          [`${directory}/ignored.txt`]: "project exclusion\n",
          "sibling/ignored.txt": "outside policy scope\n",
        });
        const result = await importReferenceSource({
          root,
          caller: "nested-ignore-test",
          policy: { secretPatterns: [] },
        });
        if (!result.ok) throw result.error;
        expect(result.value.exclusions).toEqual([
          {
            path: `${directory}/ignored.txt`,
            entry_kind: "file",
            reason: "project-ignored",
            pattern: "ignored.txt",
          },
        ]);
        expect(result.value.entries).toContainEqual(
          expect.objectContaining({
            path: "sibling/ignored.txt",
            kind: "file",
            content_state: "hashed",
          }),
        );
      },
    );

    it("preserves escaped names, comments and directory rules with trailing whitespace", async () => {
      const root = await createTestTempDirectory(
        "rea-reference-ignore-syntax-",
      );
      await writeTree(root, {
        "pkg/.gitignore":
          "# comment\n\\#hash\n\\!bang\nliteral\\ \ncache/   \n",
        "pkg/# comment": "comment is not a rule\n",
        "pkg/#hash": "escaped hash\n",
        "pkg/!bang": "escaped bang\n",
        "pkg/literal ": "escaped trailing space\n",
        "pkg/literal": "unmatched control\n",
        "pkg/deeper/cache/output.js": 'import "./missing.js";\n',
      });
      const result = await importReferenceSource({
        root,
        caller: "nested-ignore-test",
        policy: { secretPatterns: [] },
      });
      if (!result.ok) throw result.error;
      expect(result.value.exclusions.map(({ path }) => path)).toEqual([
        "pkg/!bang",
        "pkg/#hash",
        "pkg/deeper/cache",
        "pkg/literal ",
      ]);
      for (const path of ["pkg/# comment", "pkg/literal"])
        expect(result.value.entries).toContainEqual(
          expect.objectContaining({
            path,
            kind: "file",
            content_state: "hashed",
          }),
        );
      expect(result.value.relationships).toEqual([]);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "nested reference ignore precedence",
  () => {
    it("preserves default, caller, and secret precedence and prunes excluded directories", async () => {
      const root = await createTestTempDirectory(
        "rea-reference-nested-precedence-",
      );
      await writeTree(root, {
        ".gitignore": "pruned/\n",
        "pkg/.gitignore":
          "*.tmp\n!*.log\n!private.txt\n!caller.txt\n!dist/\ngenerated/\nreopened/\n",
        "pkg/keep.tmp": "caller negation\n",
        "pkg/keep.log": "caller negation of default\n",
        "pkg/app.log": "default exclusion\n",
        "pkg/private.txt": "secret exclusion\n",
        "pkg/caller.txt": "caller exclusion\n",
        "pkg/dist/output.js": 'import "./missing-default.js";\n',
        "pkg/reopened/.gitignore": "drop.js\n",
        "pkg/reopened/drop.js": 'import "./missing-reopened.js";\n',
        "pkg/reopened/keep.txt": "caller reopened directory\n",
        "pkg/generated/.gitignore": "!stale.js\n",
        "pkg/generated/stale.js": 'import "./missing-generated.js";\n',
        "pruned/.gitignore": "!stale.js\n",
        "pruned/stale.js": 'import "./missing-pruned.js";\n',
      });
      const result = await importReferenceSource({
        root,
        caller: "nested-ignore-test",
        policy: { secretPatterns: ["private.txt"] },
        excludePaths: [
          "pkg/caller.txt",
          "!pkg/keep.tmp",
          "!pkg/keep.log",
          "!pkg/reopened/",
        ],
      });
      if (!result.ok) throw result.error;
      expect(result.value.exclusions).toEqual([
        {
          path: "pkg/app.log",
          entry_kind: "file",
          reason: "default-ignored",
          pattern: "*.log",
        },
        {
          path: "pkg/caller.txt",
          entry_kind: "file",
          reason: "caller-excluded",
          pattern: "pkg/caller.txt",
        },
        {
          path: "pkg/dist",
          entry_kind: "directory",
          reason: "default-ignored",
          pattern: "dist/",
        },
        {
          path: "pkg/generated",
          entry_kind: "directory",
          reason: "project-ignored",
          pattern: "generated/",
        },
        {
          path: "pkg/private.txt",
          entry_kind: "file",
          reason: "configured-secret",
          pattern: "private.txt",
        },
        {
          path: "pkg/reopened/drop.js",
          entry_kind: "file",
          reason: "project-ignored",
          pattern: "drop.js",
        },
        {
          path: "pruned",
          entry_kind: "directory",
          reason: "project-ignored",
          pattern: "pruned/",
        },
      ]);
      expect(
        result.value.entries
          .filter(({ kind }) => kind === "file")
          .map(({ path }) => path),
      ).toEqual([
        ".gitignore",
        "pkg/.gitignore",
        "pkg/keep.log",
        "pkg/keep.tmp",
        "pkg/reopened/.gitignore",
        "pkg/reopened/keep.txt",
      ]);
      expect(result.value.relationships).toEqual([]);
    });
  },
);
