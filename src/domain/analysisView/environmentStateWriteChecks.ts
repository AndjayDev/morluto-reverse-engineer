import type { JsonValue } from "../jsonValue.js";
import { compositeKey } from "../unicodeCodePointOrder.js";
import {
  at,
  collectionPathOf,
  isObject,
  lastSegmentValue,
  listItems,
  missingRequiredFields,
  renderStateEntity,
  renderStateList,
  replaceAt,
  same,
  scalarText,
  type JsonObject,
  type StateDocument,
  type StateEntity,
  type StateItemView,
  type StateListView,
  type StateRecordFacts,
} from "./environmentStateRules.js";
import { answerQuery, renderQueryList } from "./environmentStateListQuery.js";

/** Modelled writes per target since its last check, with the fields each wrote (null: all). */
export type TouchedTargets = Map<string, Map<string, readonly string[] | null>>;

/** The fields of a write's effect on an entity no later write has overwritten: all of them for a create or delete (null). */
type ChangedFields = readonly string[] | null;

/** What a later write overwrites: the whole entity, the fields it sets, or every field (a recorded outcome). */
interface Overwrite {
  readonly whole: boolean;
  readonly fields: ReadonlySet<string> | "all";
}

/** What an earlier effect keeps after a write: nothing once every field it holds is overwritten; an update leaves a create's or delete's whole effect. */
const remaining = (
  claim: ChangedFields,
  write: Overwrite,
): ChangedFields | undefined => {
  if (write.whole) return undefined;
  if (claim === null) return null;
  const { fields } = write;
  if (fields === "all") return undefined;
  const left = claim.filter((field) => !fields.has(field));
  return left.length > 0 ? left : undefined;
};

/** Add a write's changed fields under a key: all of them once any write there changed the whole entity. */
const record = (
  map: Map<string, ChangedFields>,
  key: string,
  whole: boolean,
  changed: readonly string[],
): Map<string, ChangedFields> => {
  const before = map.get(key);
  return map.set(
    key,
    whole || before === null
      ? null
      : [...new Set([...(before ?? []), ...changed])],
  );
};

/**
 * What each write changed since the targets it touched were last checked, less what later writes overwrote, so a
 * write whose effect is gone drops out: from the entity's target, and from its collection's once no entity it changed
 * there keeps any of it.
 */
export class WriteEffects {
  /** Per entity target, the fields each tool changed there. */
  readonly #changed = new Map<string, Map<string, ChangedFields>>();
  /** Per collection target, the entities each tool's claim there rests on, with the fields it changed on each. */
  readonly #members = new Map<
    string,
    Map<string, Map<string, ChangedFields>>
  >();

  /** Forget a checked target's writes, as the touched targets do. */
  checked(key: string): void {
    this.#changed.delete(key);
    this.#members.delete(key);
  }

  /** A read showed the entity absent: no write's effect on it remains, so a write left with no entity drops from the collection. */
  removed(touched: TouchedTargets, entity: string, collection: string): void {
    this.#changed.delete(entity);
    const byTool = this.#members.get(collection);
    if (byTool === undefined) return;
    for (const [tool, entities] of byTool) {
      if (!entities.delete(entity) || entities.size > 0) continue;
      byTool.delete(tool);
      touched.get(collection)?.delete(tool);
    }
  }

  /** A write's effect replaces what earlier writes left of theirs, then joins them. */
  supersede(
    touched: TouchedTargets,
    writer: string,
    effect: {
      readonly targets: readonly string[];
      readonly fields?: readonly string[];
      readonly changed?: {
        readonly fields: readonly string[];
        readonly accumulated: readonly string[];
      };
    },
  ): void {
    const [entity, collection] = effect.targets as [string, string?];
    const changed = effect.changed?.fields ?? effect.fields ?? [];
    const whole = effect.fields === undefined;
    this.#overwrite(
      touched,
      { entity, collection, writer },
      {
        whole,
        fields: new Set(
          changed.filter(
            (field) => !effect.changed?.accumulated.includes(field),
          ),
        ),
      },
    );
    this.#changed.set(
      entity,
      record(this.#changed.get(entity) ?? new Map(), writer, whole, changed),
    );
    if (collection === undefined) return;
    const byTool = this.#members.get(collection) ?? new Map();
    byTool.set(
      writer,
      record(byTool.get(writer) ?? new Map(), entity, whole, changed),
    );
    this.#members.set(collection, byTool);
  }

  /** A recorded outcome is the entity's new baseline: what earlier writes changed on it is gone, its membership is not. */
  observed(touched: TouchedTargets, targets: readonly string[]): void {
    const [entity, collection] = targets as [string, string?];
    this.#overwrite(
      touched,
      { entity, collection, writer: undefined },
      { whole: false, fields: "all" },
    );
  }

  #overwrite(
    touched: TouchedTargets,
    at: {
      readonly entity: string;
      readonly collection: string | undefined;
      readonly writer: string | undefined;
    },
    write: Overwrite,
  ): void {
    const own = this.#changed.get(at.entity);
    for (const [tool, claim] of own ?? []) {
      const left = tool === at.writer ? claim : remaining(claim, write);
      if (left !== undefined) own!.set(tool, left);
      else {
        own!.delete(tool);
        touched.get(at.entity)?.delete(tool);
      }
    }
    if (at.collection === undefined) return;
    const byTool = this.#members.get(at.collection);
    for (const [tool, entities] of byTool ?? []) {
      const claim = entities.get(at.entity);
      if (tool === at.writer || claim === undefined) continue;
      const left = remaining(claim, write);
      if (left !== undefined) entities.set(at.entity, left);
      else entities.delete(at.entity);
      if (entities.size > 0) continue;
      byTool!.delete(tool);
      touched.get(at.collection)?.delete(tool);
    }
  }
}

export const entityTarget = (type: string, collection: string, id: string) =>
  `e${compositeKey([type, collection, id])}`;
export const collectionTarget = (type: string, collection: string) =>
  `c${compositeKey([type, collection])}`;
export const documentTarget = (tool: string) => `d${compositeKey([tool])}`;

/** The gate's copy of the state: entities in collection order and documents, changed by modelled writes. */
export class SimulatedState {
  readonly #entities = new Map<string, StateEntity>();
  readonly #collections = new Map<string, string[]>();
  readonly #documents = new Map<string, JsonValue>();

  constructor(
    entities: readonly StateEntity[],
    documents: readonly StateDocument[],
  ) {
    for (const entity of entities) this.put(entity);
    for (const document of documents)
      this.#documents.set(document.tool, document.value);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(entityTarget(type, collection, id));
  }

  members(type: string, collection: string): StateEntity[] {
    return (
      this.#collections.get(collectionTarget(type, collection)) ?? []
    ).map((key) => this.#entities.get(key)!);
  }

  ofType(type: string): StateEntity[] {
    return [...this.#entities.values()].filter(
      (entity) => entity.type === type,
    );
  }

  /** Replace an entity in place, or add it at `index` of its collection (the end when omitted). */
  put(entity: StateEntity, index?: number): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    const known = this.#entities.has(key);
    this.#entities.set(key, entity);
    if (known) return;
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    order.splice(index ?? order.length, 0, key);
    this.#collections.set(collection, order);
  }

  remove(entity: StateEntity): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    this.#entities.delete(key);
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    this.#collections.set(
      collection,
      order.filter((member) => member !== key),
    );
  }

  document(tool: string): JsonValue | undefined {
    return this.#documents.get(tool);
  }

  setDocument(tool: string, value: JsonValue): void {
    this.#documents.set(tool, value);
  }
}

/** An item read status that says the entity does not exist: 400, 404 or 410, as applications answer a missing id. */
export const isAbsence = (status: number | null): boolean =>
  status === 400 || status === 404 || status === 410;

/** A 2xx record: the only status whose response shows what a request did. */
export const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/** Hand a base recording's body and a read's body to `use` together, parsing a recording once when both are the same. */
export const withBodies = <T>(
  withBody: <U>(ordinal: number, use: (body: JsonValue | undefined) => U) => U,
  ordinals: { readonly base: number; readonly read: number },
  use: (base: JsonValue | undefined, body: JsonValue | undefined) => T,
): T => {
  const { base, read } = ordinals;
  return base === read
    ? withBody(read, (body) => use(body, body))
    : withBody(base, (served) => withBody(read, (body) => use(served, body)));
};

/** A check's outcome and the targets it covered. */
export interface CheckOutcome {
  readonly pass: boolean;
  readonly targets: readonly string[];
  /** Entities the recording, or the served base of a recorded-membership list, lists that the state does not hold, by target. */
  readonly unheld: readonly string[];
}

/** What a check compares: the read's recorded body and the served base recording it would answer on. */
interface ReadBodies {
  readonly body: JsonValue | undefined;
  /** The recording whose envelope the served answer keeps: an item view's envelope, a list line's latest init recording. */
  readonly base: JsonValue | undefined;
  readonly volatile: ReadonlySet<string>;
}

/** An item read: the answer the held entity renders into the served envelope must equal the recording; a recorded 404 or 410 agrees with none held. */
export const checkItemRead = (
  state: SimulatedState,
  view: StateItemView,
  record: StateRecordFacts,
  check: ReadBodies,
): CheckOutcome | undefined => {
  const collection = collectionPathOf(record, true);
  const id = lastSegmentValue(record.path);
  const entity = state.entity(view.type, collection, id);
  const targets = [entityTarget(view.type, collection, id)];
  if (isAbsence(record.status) || (succeeded(record) && check.body === null))
    return { pass: entity === undefined, targets, unheld: [] };
  if (!succeeded(record) || check.base === undefined) return undefined;
  const object =
    check.body === undefined ? undefined : at(check.body, view.pointer);
  // A usable body that no longer holds the entity is not what serving answers for one it holds.
  if (!isObject(object))
    return check.body === undefined || entity === undefined
      ? undefined
      : { pass: false, targets, unheld: [] };
  if (entity === undefined) return { pass: false, targets, unheld: targets };
  // Serving refuses an entity lacking a field every recording carried, so no read can confirm one.
  if (missingRequiredFields(entity, view, check.volatile).length > 0)
    return { pass: false, targets, unheld: [] };
  const shown = renderStateEntity(entity, view, check.volatile, object);
  return {
    pass: same(replaceAt(check.base, view.pointer, shown), check.body),
    targets,
    unheld: [],
  };
};

/** A list read's bodies with the listed items of the read and of its served base. */
interface ListBodies {
  readonly body: JsonValue;
  readonly base: JsonValue;
  readonly items: readonly JsonObject[];
  readonly baseItems: readonly JsonObject[];
  readonly idField: string;
  readonly volatile: ReadonlySet<string>;
  /** The collection serving lists: the answering line's. */
  readonly collection: string;
}

/** The served list rendered from the base with `members`, compared with the read; volatile fields take the read's values. */
const listCheck = (
  view: StateListView,
  check: ListBodies,
  members: readonly StateEntity[],
  total = members.length,
): boolean => {
  if (
    members.some(
      (entity) =>
        missingRequiredFields(entity, view, check.volatile).length > 0,
    )
  )
    return false;
  const observed = new Map(
    check.items.map((item) => [scalarText(item[check.idField]) ?? "", item]),
  );
  const rendered = members.map((entity) =>
    renderStateEntity(entity, view, check.volatile, observed.get(entity.id)),
  );
  const answer =
    view.query === undefined
      ? renderStateList(view, check.base, rendered)
      : renderQueryList(
          { ...view, query: view.query },
          check.base,
          rendered,
          total,
        );
  return same(answer, check.body);
};

/** The base line's and the read's listed entities by target: those the state holds, and those it no longer does. */
const listedTargets = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): { readonly targets: string[]; readonly unheld: string[] } => {
  const targets: string[] = [];
  const unheld: string[] = [];
  const ids = [...check.baseItems, ...check.items].map(
    (item) => scalarText(item[check.idField]) ?? "",
  );
  for (const id of new Set(ids))
    (state.entity(view.type, check.collection, id) === undefined
      ? unheld
      : targets
    ).push(entityTarget(view.type, check.collection, id));
  return { targets, unheld };
};

/**
 * A list read on a line the query answers: the query's matches in the state, in its order and page. Only a line whose
 * parameters all sort or page, and that shows every match, covers the collection; any other covers the entities it lists.
 */
const checkQueryList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
  values: ReadonlyMap<string, string>,
): CheckOutcome | undefined => {
  const { collection } = check;
  const result = answerQuery(
    view.query!,
    values,
    state.members(view.type, collection),
  );
  if (result === undefined) return undefined;
  return {
    pass: listCheck(view, check, result.page, result.total),
    targets: [
      ...(result.whole ? [collectionTarget(view.type, collection)] : []),
      ...result.page.map((entity) =>
        entityTarget(view.type, collection, entity.id),
      ),
    ],
    // What the base line or the read listed that the state no longer holds: the read shows whether it went.
    unheld: listedTargets(state, view, check).unheld,
  };
};

/** A list read of every entity of a collection: membership, order, fields and counters must render from the state. */
const checkAllList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): CheckOutcome => {
  const { collection } = check;
  const members = state.members(view.type, collection);
  const held = new Set(members.map((entity) => entity.id));
  return {
    pass: listCheck(view, check, members),
    targets: [
      collectionTarget(view.type, collection),
      ...members.map((entity) =>
        entityTarget(view.type, collection, entity.id),
      ),
    ],
    unheld: check.items
      .map((item) => scalarText(item[check.idField]) ?? "")
      .filter((id) => !held.has(id))
      .map((id) => entityTarget(view.type, collection, id)),
  };
};

/** A list read of recorded members: the served list holds the base's members the state still holds, so a member it dropped or never listed fails. */
const checkRecordedList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): CheckOutcome => {
  const { collection } = check;
  const idOf = (item: JsonObject) => scalarText(item[check.idField]) ?? "";
  const members = check.baseItems.flatMap((item) => {
    const entity = state.entity(view.type, collection, idOf(item));
    return entity === undefined ? [] : [entity];
  });
  return {
    pass: listCheck(view, check, members),
    ...listedTargets(state, view, check),
  };
};

/** A list read on a checked line, compared with the answer the served environment renders on that line's base recording from the collection it names: every entity when that line lists them all. */
export const checkListRead = (
  state: SimulatedState,
  view: StateListView,
  record: StateRecordFacts,
  check: ReadBodies & {
    readonly idField: string;
    readonly collection: string;
    /** Whether the base line lists every entity of its collection. */
    readonly all: boolean;
    /** The read's query values, when the query answers its line. */
    readonly query?: ReadonlyMap<string, string> | undefined;
  },
): CheckOutcome | undefined => {
  if (!succeeded(record)) return undefined;
  const { body, base } = check;
  const baseItems =
    base === undefined ? undefined : listItems(base, view.pointer);
  if (body === undefined || base === undefined || baseItems === undefined)
    return undefined;
  // A usable body that no longer holds the list is not what serving answers on this line.
  const items = listItems(body, view.pointer);
  const bodies = { ...check, body, base, items: items ?? [], baseItems };
  const outcome = check.all
    ? checkAllList(state, view, bodies)
    : check.query === undefined
      ? checkRecordedList(state, view, bodies)
      : checkQueryList(state, view, bodies, check.query);
  if (outcome === undefined) return undefined;
  return items === undefined ? { ...outcome, pass: false } : outcome;
};

/** A document read on its checked line must equal the held document. */
export const checkDocumentRead = (
  state: SimulatedState,
  tool: string,
  record: StateRecordFacts,
  body: JsonValue | undefined,
): CheckOutcome | undefined => {
  if (!succeeded(record)) return undefined;
  const value = state.document(tool);
  if (body === undefined || value === undefined) return undefined;
  return {
    pass: same(value, body),
    targets: [documentTarget(tool)],
    unheld: [],
  };
};

/**
 * Check, field by field, the writes that changed an entity an unmodelled write also changed:
 * each write's own fields must show as the state holds them. A create wrote every field, so it
 * cannot be told apart from the unmodelled change and is not checked.
 */
export const writtenFieldChecks = (
  entity: StateEntity,
  view: StateItemView,
  observed: JsonObject,
  check: {
    readonly volatile: ReadonlySet<string>;
    readonly writes: ReadonlyMap<string, readonly string[] | null>;
  },
): Map<string, boolean> => {
  const shown = renderStateEntity(entity, view, check.volatile, observed);
  const outcomes = new Map<string, boolean>();
  for (const [tool, fields] of check.writes) {
    const compared = (fields ?? []).filter(
      (field) => Object.hasOwn(observed, field) || Object.hasOwn(shown, field),
    );
    if (fields === null || compared.length === 0) continue;
    outcomes.set(
      tool,
      compared.every((field) => same(shown[field], observed[field])),
    );
  }
  return outcomes;
};
