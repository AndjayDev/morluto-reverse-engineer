import type { JsonObject } from "../../domain/analysisView/environmentStateRules.js";
import type { JsonValue } from "../../domain/jsonValue.js";

/** Field names that hold an identifier: `id`, `uuid`, `guid`, or names ending in `id` or `_id`. */
export const ID_FIELD = /^(id|uuid|guid)$|(_id|Id|ID|_uuid|Uuid)$/u;

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalarId = (value: JsonValue | undefined): value is string | number =>
  (typeof value === "string" && value !== "") ||
  (typeof value === "number" && Number.isFinite(value));

/** Live identifier values and the environment's values they stand for, in both directions. */
export class IdMap {
  readonly #toEnv = new Map<string, string | number>();
  readonly #toLive = new Map<string, string | number>();
  #conflicts = 0;

  /** Pair a live value with an environment value; the first pairing of either side wins. */
  learn(live: string | number, env: string | number): void {
    const liveKey = String(live);
    const envKey = String(env);
    if (liveKey === envKey) return;
    const known = this.#toEnv.get(liveKey);
    if (known !== undefined) {
      if (String(known) !== envKey) this.#conflicts += 1;
      return;
    }
    if (this.#toLive.has(envKey)) {
      this.#conflicts += 1;
      return;
    }
    this.#toEnv.set(liveKey, env);
    this.#toLive.set(envKey, live);
  }

  env(live: string | number): string | number | undefined {
    return this.#toEnv.get(String(live));
  }

  hasLive(value: string | number): boolean {
    return this.#toEnv.has(String(value));
  }

  hasEnv(value: string | number): boolean {
    return this.#toLive.has(String(value));
  }

  get size(): number {
    return this.#toEnv.size;
  }

  get conflicts(): number {
    return this.#conflicts;
  }
}

/** A field every object element has as a non-empty string, unique on its side; not an identifier, which differs across sides. */
const keyCandidates = (items: readonly JsonObject[]): Set<string> => {
  const candidates = new Set<string>();
  const first = items[0];
  if (first === undefined) return candidates;
  for (const key of Object.keys(first)) {
    if (ID_FIELD.test(key)) continue;
    const values = items.map((item) => item[key]);
    if (
      values.every((value) => typeof value === "string" && value !== "") &&
      new Set(values).size === values.length
    )
      candidates.add(key);
  }
  return candidates;
};

/**
 * Pair two arrays' object elements by the natural key that pairs the most, as [live index, env index]; arrays of other
 * values, or with no shared key, pair by position up to the shorter length.
 */
export const pairElements = (
  live: readonly JsonValue[],
  env: readonly JsonValue[],
): Array<readonly [number, number]> => {
  const byPosition = (): Array<readonly [number, number]> =>
    Array.from({ length: Math.min(live.length, env.length) }, (_, index) => [
      index,
      index,
    ]);
  if (!live.every(isObject) || !env.every(isObject)) return byPosition();
  const liveItems = live as readonly JsonObject[];
  const envItems = env as readonly JsonObject[];
  const liveKeys = keyCandidates(liveItems);
  const envKeys = keyCandidates(envItems);
  let best:
    | { key: string; pairs: Array<readonly [number, number]> }
    | undefined;
  for (const key of [...liveKeys].sort()) {
    if (!envKeys.has(key)) continue;
    const envIndex = new Map(envItems.map((item, index) => [item[key], index]));
    const pairs: Array<readonly [number, number]> = [];
    for (const [index, item] of liveItems.entries()) {
      const match = envIndex.get(item[key]);
      if (match !== undefined) pairs.push([index, match]);
    }
    if (pairs.length > (best?.pairs.length ?? 0)) best = { key, pairs };
  }
  return best?.pairs ?? byPosition();
};

/** Learn identifier pairs from the live and environment answers to one call: identifier fields of objects that pair, at any depth. */
export const learnIds = (
  live: JsonValue | undefined,
  env: JsonValue | undefined,
  map: IdMap,
  heldIds: ReadonlySet<string>,
): void => {
  if (Array.isArray(live) && Array.isArray(env)) {
    for (const [left, right] of pairElements(live, env))
      learnIds(live[left], env[right], map, heldIds);
    return;
  }
  if (!isObject(live) || !isObject(env)) return;
  for (const [key, value] of Object.entries(live)) {
    if (!Object.hasOwn(env, key)) continue;
    const other = env[key];
    if (
      isScalarId(value) &&
      isScalarId(other) &&
      (ID_FIELD.test(key) || heldIds.has(String(other)))
    )
      map.learn(value, other);
    else learnIds(value, other, map, heldIds);
  }
};

/** A value with every string or number equal to a mapped live identifier replaced by the environment's value, in its own type. */
export const translateValue = (value: JsonValue, map: IdMap): JsonValue => {
  if (Array.isArray(value))
    return value.map((item) => translateValue(item, map));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        translateValue(item, map),
      ]),
    );
  if (!isScalarId(value)) return value;
  const env = map.env(value);
  if (env === undefined) return value;
  return typeof value === "string"
    ? String(env)
    : typeof env === "number"
      ? env
      : value;
};
