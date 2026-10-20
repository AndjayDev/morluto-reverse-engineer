import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The name a working directory had when the store observed it, and the work
 * another session did at that name afterwards.
 *
 * The store observes the name and acts on the observation, so the seam
 * establishes the interleaving the finding describes: one session observes a
 * name that is not a directory, and another session replaces it with its own
 * directory before the first one acts.
 */
const race = vi.hoisted(() => ({
  path: "",
  afterObservation: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    lstat: async (...args: Parameters<typeof filesystem.lstat>) => {
      const stats = await filesystem.lstat(...args);
      if (String(args[0]) !== race.path || race.afterObservation === undefined)
        return stats;
      const afterObservation = race.afterObservation;
      race.afterObservation = undefined;
      await afterObservation();
      // The store acts on the observation it made, so the stale facts are
      // the ones it received.
      return stats;
    },
  };
});

import { ghidraProjectCacheKey } from "./GhidraProjectCacheKey.js";
import {
  ghidraProjectCacheIdentity as identity,
  ghidraProjectCacheTarget,
} from "./GhidraProjectCache.fixture.js";
import {
  GHIDRA_PROJECT_LOCK_DIRECTORY,
  GHIDRA_PROJECT_STAGING_DIRECTORY,
} from "./GhidraProjectCacheTypes.js";
import {
  GhidraProjectStore,
  type GhidraProjectPublishInput,
} from "./GhidraProjectStore.js";

const roots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-ghidra-cache-race-"));
  roots.push(root);
  return root;
};

/** An expanded Ghidra project the store can copy into the cache. */
const tempProject = async (): Promise<string> => {
  const project = await mkdtemp(join(tmpdir(), "rea-ghidra-runtime-race-"));
  roots.push(project);
  await mkdir(join(project, "rea-project.rep", "idata"), { recursive: true });
  await writeFile(join(project, "rea-project.gpr"), "");
  await writeFile(
    join(project, "rea-project.rep", "idata", "db.gbf"),
    Buffer.from("analyzed-program-bytes"),
  );
  return project;
};

afterEach(async () => {
  race.path = "";
  race.afterObservation = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GhidraProjectStore working directory replacement", () => {
  it("keeps the staging copy another session is making when the name was observed as a file", async () => {
    const root = await tempRoot();
    const staging = join(root, GHIDRA_PROJECT_STAGING_DIRECTORY);
    // The name holds a file: the state a root another principal could write
    // leaves behind.
    await writeFile(staging, "not a directory");
    race.path = staging;
    race.afterObservation = async () => {
      // Another session replaces the name with its own directory and starts a
      // copy there.
      await unlink(staging);
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, "live"), "live");
    };
    const store = new GhidraProjectStore({
      root,
      maxBytes: 1_000_000,
      platform: "linux",
    });

    const pruned = await store.prune();
    expect(pruned.ok).toBe(true);
    // The copy another session is making is not removed by the session that
    // observed the name before the directory existed.
    await expect(readFile(join(staging, "live"), "utf8")).resolves.toBe("live");
  });

  it("keeps the lock another session holds when the name was observed as a file", async () => {
    const root = await tempRoot();
    const locks = join(root, GHIDRA_PROJECT_LOCK_DIRECTORY);
    const project = await tempProject();
    const key = ghidraProjectCacheKey(identity());
    await writeFile(locks, "not a directory");
    race.path = locks;
    race.afterObservation = async () => {
      // Another session replaces the name with its own directory and holds the
      // lock for the key in it.
      await unlink(locks);
      await mkdir(locks, { recursive: true });
      await writeFile(join(locks, `${key}.lock`), "held");
    };
    const store = new GhidraProjectStore({
      root,
      maxBytes: 1_000_000,
      platform: "linux",
    });
    const reservation = await store.prepare({
      identity: identity(),
      mode: "on",
    });
    if (!reservation.ok || reservation.value === null)
      throw new Error("expected a populate-capable reservation");

    const published = await store.publish({
      reservation: reservation.value,
      identity: identity(),
      target: ghidraProjectCacheTarget(),
      sourceProjectDirectory: project,
      programName: "target-abc123.dll",
      programSha256: "c".repeat(64),
      producer: { reaVersion: "6.4.0", runId: "run-1" },
    } satisfies GhidraProjectPublishInput);
    // The lock another session holds is not removed, so the publisher reports
    // it instead of publishing beside it.
    expect(published.ok).toBe(false);
    if (published.ok) throw new Error("expected a busy failure");
    expect(published.error.reason).toBe("busy");
    await expect(readFile(join(locks, `${key}.lock`), "utf8")).resolves.toBe(
      "held",
    );
  });
});
