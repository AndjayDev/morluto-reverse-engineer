import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { GhidraProjectCacheError } from "./GhidraProjectCacheTypes.js";

/**
 * Suffix of the file beside the cache root that serialises a repair.
 *
 * The lock lives beside the root because the repair replaces the root itself,
 * so a lock inside it would not survive the replacement.
 */
const REPAIR_LOCK_SUFFIX = ".repair";

/**
 * A repair lock that has been silent for longer than this belongs to a
 * session that died, and is taken over so one crash does not disable the
 * cache for good.
 */
const REPAIR_LOCK_STALE_MS = 10 * 60 * 1000;

/** A held repair lock and what taking it proved about the root. */
export interface RepairLock {
  /** The file that serialises the repair. */
  readonly path: string;
  /**
   * The token this session wrote into the lock. It names the owner, so a
   * lock another session holds is never taken for this session's own.
   */
  readonly token: string;
  /**
   * Another session held the lock, so the root may have been created or
   * rebuilt while this session waited for it.
   */
  readonly contended: boolean;
}

/** Path of the file that serialises a root repair between sessions. */
const repairLockPath = (root: string): string =>
  join(dirname(root), `${basename(root)}${REPAIR_LOCK_SUFFIX}`);

/**
 * How long the repair lock beside the root has been silent.
 *
 * A lock that does not exist is as old as it can be: no session holds it.
 */
const repairLockAge = async (root: string): Promise<number> =>
  await lstat(repairLockPath(root)).then(
    (stats) => Date.now() - stats.mtimeMs,
    () => Number.POSITIVE_INFINITY,
  );

/**
 * The token the lock carries, or undefined when it cannot be read.
 *
 * The token names the session that holds the lock. It is what tells a lock
 * that is taken over apart from the lock of a session that took it over
 * first.
 */
const readRepairLockToken = async (path: string): Promise<string | undefined> =>
  await readFile(path, "utf8").then(
    (content) => content.trim(),
    () => undefined,
  );

/**
 * Create the lock file with this session's token.
 *
 * Returns whether the lock was created. A lock that is already there belongs
 * to another session.
 */
const createRepairLock = async (
  path: string,
  token: string,
): Promise<boolean> => {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (cause: unknown) {
    if (isAlreadyExists(cause)) return false;
    throw cause;
  }
};

/**
 * Take the repair lock without waiting for it.
 *
 * Returns `undefined` when another live session holds the lock, so a caller
 * that only reclaims what a repair left behind steps aside instead of
 * reporting a busy root. A lock a dead session left behind is taken over, so
 * one crash does not leave the copies of a repair on the disk for good.
 *
 * The lock carries the token of the session that holds it, and a lock that is
 * taken over is moved aside before it is replaced. The token the moved-aside
 * lock carries decides whether it is the lock that was observed: a lock
 * another session holds in the meantime is put back instead of being removed,
 * so a takeover never takes the lock away from a live session. The session
 * that holds the lock releases only its own lock, for the same reason.
 */
export const tryAcquireRepairLock = async (
  root: string,
): Promise<RepairLock | undefined> => {
  const path = repairLockPath(root);
  const token = randomUUID();
  if (await createRepairLock(path, token))
    return { path, token, contended: false };
  // A lock a live session holds is not stolen.
  const observed = await readRepairLockToken(path);
  if (observed === undefined) return undefined;
  if ((await repairLockAge(root)) < REPAIR_LOCK_STALE_MS) return undefined;
  // The lock is read again before it is broken, so a lock another session
  // took over in the meantime is left alone instead of being moved aside.
  if ((await readRepairLockToken(path)) !== observed) return undefined;
  // The stale lock is moved aside before it is replaced, so the lock that is
  // taken over can be compared with the one that was observed.
  const aside = `${path}.${token}.aside`;
  try {
    await rename(path, aside);
  } catch (cause: unknown) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
  const displaced = await readRepairLockToken(aside);
  if (displaced !== observed) {
    // The lock that was there is not the one that was observed: another
    // session took it over. It is put back, and the lock stays with its
    // owner.
    await rename(aside, path).catch(() => undefined);
    return undefined;
  }
  const taken = await createRepairLock(path, token);
  await rm(aside, { force: true }).catch(() => undefined);
  if (!taken) return undefined;
  return { path, token, contended: true };
};

/**
 * Take the repair lock, so only one session changes the cache root.
 *
 * A lock a live session holds is not stolen: the caller reports the root as
 * busy instead of changing a root another session is rebuilding, so no
 * session can read or discard a project while it is still being copied. A
 * lock that has been silent for longer than any plausible repair belongs to a
 * session that died, and is taken over so one crash does not disable the
 * cache for good.
 */
export const acquireRepairLock = async (root: string): Promise<RepairLock> => {
  const lock = await tryAcquireRepairLock(root);
  if (lock !== undefined) return lock;
  throw new GhidraProjectCacheError(
    "busy",
    "Another session is rebuilding the Ghidra project cache root",
    repairLockPath(root),
  );
};

/**
 * Release the repair lock so another session can rebuild the root.
 *
 * Only the lock this session holds is removed. A lock another session took
 * over carries that session's token, so it is left in place.
 */
export const releaseRepairLock = async (lock: RepairLock): Promise<void> => {
  if ((await readRepairLockToken(lock.path)) !== lock.token) return;
  await rm(lock.path, { force: true }).catch(() => undefined);
};

/**
 * Keep the repair lock alive while the preserved projects are copied.
 *
 * A lock another session took over carries that session's token, so the
 * repair that lost its lock stops instead of changing a root another session
 * is rebuilding.
 */
export const keepRepairLockAlive = async (lock: RepairLock): Promise<void> => {
  if ((await readRepairLockToken(lock.path)) !== lock.token)
    throw new GhidraProjectCacheError(
      "busy",
      "Another session took over the Ghidra project cache root repair",
      lock.path,
    );
  const now = new Date();
  await utimes(lock.path, now, now).catch(() => undefined);
};

const isAlreadyExists = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "EEXIST";

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";
