/**
 * The store: entities of the kinds an application gives it, in one order of changes (EM1 to EM10, EM15).
 *
 * Every operation runs to completion, synchronously, before the next begins, so changes are applied one at
 * a time. A change is appended to the storage port before any read sees it or its answer is returned; a
 * failed append stops the store, which then answers nothing more.
 */
import {
	firstUnsafeInteger,
	nestingDepth,
	observePromises,
	prepareShapeDocument,
	readPlainJson,
	snapshotJson,
	toCanonicalJson,
	utf8ByteLength,
	type JsonObject,
	type JsonValue,
	type PreparedShape,
	type ShapeMisfit,
} from "@apnex/shape-check";
import { compareCodePoints, isJsonObject, recoverLog, type RecoveredState } from "./change-log.js";
import { requireInputShape } from "./operation-inputs.js";
import { sha256Hex } from "./sha256.js";
import { cutTo128, storeRefusal } from "./store-refusal.js";
import type {
	ChangeRecord,
	ClockPort,
	CreateInput,
	DeleteAnswer,
	DeleteInput,
	EntityAnswer,
	EntityEnvelope,
	EntityStore,
	FindAnswer,
	FindInput,
	HistoryBoundAnswer,
	LoadedRecord,
	LogRecord,
	OpeningRefusal,
	ReadAnswer,
	ReadInput,
	RepeatCheck,
	StoragePort,
	StoreOpening,
	StoreOptions,
	StoreOutcome,
	StoreRefusal,
	UpdateInput,
	WriteAnswer,
	WriteContext,
	WriteOperation,
} from "./store-types.js";

/** EM1's name pattern. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** EM2's tag pattern. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}$/;

/** The limits the target states (EM2, EM8, EM10). */
export const LIMITS = Object.freeze({
	tags: 32,
	envelopeDepth: 27,
	shapeDepth: 20,
	shapeBytes: 65536,
	largestEntityBytes: 262144,
	pageBytes: 524288,
	historyMsMin: 1,
	historyMsMax: 365 * 24 * 60 * 60 * 1000,
	/** EM8's clock range: 0000-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z, the times written with a four-digit year. */
	clockMsMin: -62167219200000,
	clockMsMax: 253402300799999,
});

type Judge = (body: JsonValue) => readonly ShapeMisfit[];

/** Opens a store over a storage port, recovering every record the port holds, or refuses naming the reason. */
export function openEntityStore(options: StoreOptions): StoreOpening {
	if (options === null || typeof options !== "object") throw new TypeError("openEntityStore needs its options");
	const { storage, clock, historyMs, maxEntityBytes, kinds } = options;
	if (!storage || typeof storage.load !== "function" || typeof storage.append !== "function") throw new TypeError("openEntityStore needs a storage port with load and append");
	if (!clock || typeof clock.now !== "function") throw new TypeError("openEntityStore needs a clock port with now");
	if (kinds === null || typeof kinds !== "object" || Array.isArray(kinds)) throw new TypeError("openEntityStore needs its kinds as an object of name to body shape");

	const refuse = (code: OpeningRefusal["code"], message: string, details: OpeningRefusal["details"]): StoreOpening => ({ opened: false, refusal: { code, message, details } });

	if (typeof historyMs !== "number" || !Number.isInteger(historyMs) || historyMs < LIMITS.historyMsMin || historyMs > LIMITS.historyMsMax) {
		return refuse("invalid-bound", "The history bound is not a whole number of milliseconds from 1 millisecond to 365 days.", { historyMs: typeof historyMs === "number" && Number.isFinite(historyMs) ? historyMs : null });
	}
	if (typeof maxEntityBytes !== "number" || !Number.isInteger(maxEntityBytes) || maxEntityBytes < 1 || maxEntityBytes > LIMITS.largestEntityBytes) {
		return refuse("invalid-size", "The largest entity size is not a whole number of bytes from 1 to 262144.", { maxEntityBytes: typeof maxEntityBytes === "number" && Number.isFinite(maxEntityBytes) ? maxEntityBytes : null });
	}
	// EM10's reasons are checked in their order, each over every kind before the next reason, so a store
	// given several faulty kinds is refused for the earliest reason any of them has (see the report's questions).
	const entries = Object.entries(kinds);
	for (const [kind] of entries) {
		if (!NAME_PATTERN.test(kind)) return refuse("invalid-kind-name", "A kind's name does not match ^[a-z0-9][a-z0-9-]{0,62}$.", { kind: cutTo128(kind).text });
	}
	// A kind shape that is not a JSON value - one holding a cycle included - is the application's
	// programming error, not a refusal (EM10). Depth is measured before shape-check prepares a shape, so
	// shape-check, whose walk follows the shape, never meets one deeper than 20 levels.
	const snapshots = new Map<string, JsonValue>();
	for (const [kind, shape] of entries) {
		const snap = snapshotJson(shape);
		if (!snap.ok) throw new TypeError(`the body shape of kind ${JSON.stringify(cutTo128(kind).text)} is not a JSON value`);
		snapshots.set(kind, snap.value);
	}
	for (const [kind] of entries) {
		const shape = snapshots.get(kind) as JsonValue;
		const depth = nestingDepth(shape);
		if (depth > LIMITS.shapeDepth) return refuse("shape-too-deep", "A kind's body shape nests more than 20 levels.", { kind, depth, limit: LIMITS.shapeDepth });
	}
	const prepared = new Map<string, PreparedShape>();
	for (const [kind] of entries) {
		const shape = snapshots.get(kind) as JsonValue;
		const document = prepareShapeDocument(shape);
		if (!document.accepted) return refuse("shape-refused", "shape-check refuses a kind's body shape.", { kind, problems: document.problems.map((p) => ({ ...p })) });
		prepared.set(kind, document);
	}
	for (const [kind] of entries) {
		const shape = snapshots.get(kind) as JsonValue;
		const unsafe = firstUnsafeInteger(shape);
		if (unsafe !== null) return refuse("unsafe-shape", "A kind's body shape holds an integer more than 9007199254740991 from zero.", { kind, pointer: unsafe.pointer });
	}
	for (const [kind] of entries) {
		const shape = snapshots.get(kind) as JsonValue;
		const bytes = canonicalSize(shape);
		if (bytes > LIMITS.shapeBytes) return refuse("shape-too-large", "A kind's body shape exceeds 65536 bytes in canonical JSON.", { kind, bytes, limit: LIMITS.shapeBytes });
	}
	const judges = new Map<string, Judge>();
	for (const [kind, document] of prepared) {
		if (!document.accepted) continue;
		judges.set(kind, (body) => {
			const verdict = document.judge(body);
			return verdict.verdict === "misfit" ? verdict.misfits : [];
		});
	}

	const loaded = readStorageLoad(storage);
	if (!loaded.ok) return refuse(loaded.fault.code, loaded.fault.message, { line: loaded.fault.line });
	const recovered = recoverLog(loaded.records);
	if (!recovered.ok) return refuse("log-corrupt", recovered.message, { line: recovered.line });

	return { opened: true, store: new Store(storage, clock, historyMs, maxEntityBytes, judges, recovered.state) };
}

/** The error a stopped store throws for every call after an append failed. */
function stoppedError(cause: unknown): Error {
	const error = new Error("entity-store stopped: an append to its storage failed, so it answers nothing more", { cause });
	(error as Error & { code: string }).code = "store-stopped";
	return error;
}

/** Milliseconds to ISO 8601 in UTC, to the millisecond. */
function iso(ms: number): string {
	return new Date(ms).toISOString();
}

class Store implements EntityStore {
	#stopped: unknown = undefined;
	#isStopped = false;

	constructor(
		private readonly storage: StoragePort,
		private readonly clock: ClockPort,
		private readonly historyMs: number,
		private readonly maxEntityBytes: number,
		private readonly judges: Map<string, Judge>,
		private readonly state: RecoveredState,
	) {}

	// The store's time: the later of the application's clock and the latest time in the change log (EM8).
	// The clock's value is floored and checked against EM8's range before it is compared with any logged
	// time, so a value outside the range throws even when a later logged time would have masked it.
	#now(): number {
		const clock = this.clock.now();
		if (typeof clock !== "number" || !Number.isFinite(clock)) throw new TypeError("the clock port gave a time that is not a finite number");
		const ms = Math.floor(clock);
		if (ms < LIMITS.clockMsMin || ms > LIMITS.clockMsMax) {
			throw new RangeError(`the clock port gave ${ms} ms, outside ${LIMITS.clockMsMin} to ${LIMITS.clockMsMax} (0000-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z)`);
		}
		return Math.max(ms, this.state.latestAt);
	}

	#alive(): void {
		if (this.#isStopped) throw stoppedError(this.#stopped);
	}

	#append(record: LogRecord): void {
		try {
			this.storage.append(record);
		} catch (cause) {
			this.#isStopped = true;
			this.#stopped = cause;
			throw stoppedError(cause);
		}
	}

	// Before any decision about retention, the store's time reaches the change log (EM8).
	#timeForDecision(now: number): number {
		if (now > this.state.latestAt) {
			this.#append({ type: "time", at: iso(now) });
			this.state.latestAt = now;
		}
		return now;
	}

	#within(at: number, now: number): boolean {
		return now - at < this.historyMs;
	}

	checkRepeat(operation: WriteOperation, input: CreateInput | UpdateInput | DeleteInput, write: WriteContext): RepeatCheck {
		this.#alive();
		const json = snapshotInput(input);
		requireInputShape(operation, json);
		requireWrite(write);
		return this.#checkRepeat(operation, json, write, this.#now());
	}

	// `clock` is the store's time read once for the call, so a clock outside EM8's range has already thrown.
	#checkRepeat(operation: WriteOperation, input: JsonValue, write: WriteContext, clock: number): RepeatCheck {
		const remembered = this.state.writes.get(write.writeId);
		if (remembered === undefined) return { repeat: "none" };
		const now = this.#timeForDecision(clock);
		if (!this.#within(remembered.at, now)) return { repeat: "none" };
		if (remembered.digest !== writeDigest(operation, input, write.writer)) return { repeat: "identity-reused", refusal: storeRefusal("identity-reused", { writeId: write.writeId }) };
		return { repeat: "recognised", answer: cloneValue(remembered.answer) };
	}

	create(input: CreateInput, write: WriteContext): StoreOutcome<EntityAnswer> {
		return this.#write("create", input, write, (now, snap) => this.#planCreate(snap as unknown as CreateInput, write, now)) as StoreOutcome<EntityAnswer>;
	}

	update(input: UpdateInput, write: WriteContext): StoreOutcome<EntityAnswer> {
		return this.#write("update", input, write, (now, snap) => this.#planUpdate(snap as unknown as UpdateInput, write, now)) as StoreOutcome<EntityAnswer>;
	}

	delete(input: DeleteInput, write: WriteContext): StoreOutcome<DeleteAnswer> {
		return this.#write("delete", input, write, (now, snap) => this.#planDelete(snap as unknown as DeleteInput, now)) as StoreOutcome<DeleteAnswer>;
	}

	// A write: its identity first (EM7), then the rows of EM9 in order, then the change, appended before it is seen.
	#write(operation: WriteOperation, input: unknown, write: WriteContext, plan: (now: number, snap: JsonValue) => Plan | StoreRefusal): StoreOutcome<WriteAnswer> {
		this.#alive();
		const json = snapshotInput(input);
		requireInputShape(operation, json);
		requireWrite(write);
		// The clock is read, and checked against EM8's range, once, before the identity or any row is decided.
		const now = this.#now();
		const repeat = this.#checkRepeat(operation, json, write, now);
		if (repeat.repeat === "recognised") return { outcome: "answered", answer: repeat.answer };
		if (repeat.repeat === "identity-reused") return { outcome: "refused", refusal: repeat.refusal };
		const planned = plan(now, json);
		if ("part" in planned) return { outcome: "refused", refusal: planned };
		const record: ChangeRecord = {
			type: "change",
			position: planned.position,
			at: planned.at,
			writer: write.writer,
			writeId: write.writeId,
			digest: writeDigest(operation, json, write.writer),
			answer: planned.answer,
			writes: [{ operation, id: planned.id, entity: planned.entity }],
		};
		this.#append(record);
		this.state.apply(record, planned.atMs);
		return { outcome: "answered", answer: cloneValue(planned.answer) };
	}

	// The position and time a change made now would take.
	#next(now: number): { position: number; atMs: number; at: string } {
		const atMs = Math.max(now, this.state.latestAt);
		return { position: this.state.position + 1, atMs, at: iso(atMs) };
	}

	#unknownKind(kind: string | undefined): StoreRefusal | undefined {
		return kind !== undefined && !this.judges.has(kind) ? storeRefusal("unknown-kind", { kind }) : undefined;
	}

	#planCreate(input: CreateInput, write: WriteContext, now: number): Plan | StoreRefusal {
		const refusal = this.#unknownKind(input.kind)
			?? this.#nameRefusal(input.kind, input.name, undefined)
			?? tagRefusal(input.tags);
		if (refusal) return refusal;
		const next = this.#next(now);
		const id = `e${next.position}.1`;
		const stamp = { position: next.position, at: next.at, writer: write.writer };
		const entity: EntityEnvelope = { id, kind: input.kind, name: input.name, tags: sortTags(input.tags), body: input.body, revision: 1, created: stamp, changed: { ...stamp } };
		return this.#envelopeRefusal(entity) ?? { ...next, id, entity, answer: { position: next.position, entity } };
	}

	#planUpdate(input: UpdateInput, write: WriteContext, now: number): Plan | StoreRefusal {
		const target = input.target;
		let refusal = this.#unknownKind(target.kind) ?? targetRefusal(target);
		if (refusal) return refusal;
		if (input.name === undefined && input.tags === undefined && input.body === undefined) return storeRefusal("empty-update");
		const current = this.state.resolve(target);
		if (current === undefined) return storeRefusal("not-found", { target: target as JsonObject });
		refusal = revisionRefusal(input.expectedRevision, current.revision)
			?? (input.name !== undefined ? this.#nameRefusal(current.kind, input.name, current.id) : undefined)
			?? (input.tags !== undefined ? tagRefusal(input.tags) : undefined);
		if (refusal) return refusal;
		let body = current.body;
		if (input.body !== undefined) body = isJsonObject(current.body) && isJsonObject(input.body) ? { ...current.body, ...input.body } : input.body;
		const next = this.#next(now);
		const entity: EntityEnvelope = {
			id: current.id,
			kind: current.kind,
			name: input.name ?? current.name,
			tags: input.tags !== undefined ? sortTags(input.tags) : [...current.tags],
			body,
			revision: current.revision + 1,
			created: { ...current.created },
			changed: { position: next.position, at: next.at, writer: write.writer },
		};
		return this.#envelopeRefusal(entity) ?? { ...next, id: entity.id, entity, answer: { position: next.position, entity } };
	}

	#planDelete(input: DeleteInput, now: number): Plan | StoreRefusal {
		const target = input.target;
		let refusal = this.#unknownKind(target.kind) ?? targetRefusal(target);
		if (refusal) return refusal;
		const current = this.state.resolve(target);
		if (current === undefined) return storeRefusal("not-found", { target: target as JsonObject });
		refusal = revisionRefusal(input.expectedRevision, current.revision);
		if (refusal) return refusal;
		const next = this.#next(now);
		const deleted = { id: current.id, kind: current.kind, name: current.name, revision: current.revision + 1 };
		return { ...next, id: current.id, entity: null, answer: { position: next.position, deleted } };
	}

	// invalid-name, then name-taken: a create or rename to a name another entity of the kind holds.
	#nameRefusal(kind: string, name: string, self: string | undefined): StoreRefusal | undefined {
		if (!NAME_PATTERN.test(name)) return storeRefusal("invalid-name", { name });
		const holder = this.state.names.get(kind)?.get(name);
		if (holder !== undefined && holder !== self) return storeRefusal("name-taken", { kind, name }, { id: holder });
		return undefined;
	}

	// misfit, then entity-too-large, entity-too-deep and unsafe-number, on the envelope the write would leave.
	#envelopeRefusal(entity: EntityEnvelope): StoreRefusal | undefined {
		const misfits = (this.judges.get(entity.kind) as Judge)(entity.body);
		if (misfits.length > 0) return storeRefusal("misfit", {}, {}, misfits);
		const envelope = entity as unknown as JsonValue;
		const bytes = canonicalSize(envelope);
		if (bytes > this.maxEntityBytes) return storeRefusal("entity-too-large", {}, { bytes, limit: this.maxEntityBytes });
		const depth = nestingDepth(envelope);
		if (depth > LIMITS.envelopeDepth) return storeRefusal("entity-too-deep", {}, { depth, limit: LIMITS.envelopeDepth });
		const unsafe = firstUnsafeInteger(envelope);
		if (unsafe !== null) return storeRefusal("unsafe-number", {}, { pointer: unsafe.pointer });
		return undefined;
	}

	read(rawInput: ReadInput): StoreOutcome<ReadAnswer> {
		this.#alive();
		const input = snapshotInput(rawInput) as unknown as ReadInput;
		requireInputShape("read", input);
		const refusal = this.#unknownKind(input.target.kind) ?? targetRefusal(input.target);
		if (refusal) return { outcome: "refused", refusal };
		const entity = this.state.resolve(input.target);
		return { outcome: "answered", answer: { position: this.state.position, entity: entity === undefined ? null : cloneValue(entity) } };
	}

	find(rawInput: FindInput): StoreOutcome<FindAnswer> {
		this.#alive();
		const input = snapshotInput(rawInput) as unknown as FindInput;
		requireInputShape("find", input);
		const unknown = this.#unknownKind(input.kind);
		if (unknown) return { outcome: "refused", refusal: unknown };
		const current = this.state.position;
		const asOf = input.asOf ?? current;
		if (asOf < 0 || asOf > current) return { outcome: "refused", refusal: storeRefusal("invalid-position", {}, { position: asOf, current }) };
		if (asOf < current) {
			const now = this.#timeForDecision(this.#now());
			if (!this.#within(this.state.changeAt(asOf + 1), now)) return { outcome: "refused", refusal: storeRefusal("position-not-held", {}, { position: asOf }) };
		}
		// A find's tags are a set (EM2): more than 32 distinct tags match nothing, as no entity carries more
		// than 32, while any number of copies of one tag is that tag once (EM9). Tags are not judged.
		const wanted = new Set(input.tags ?? []);
		const matches = wanted.size > LIMITS.tags ? [] : this.state
			.entitiesAsOf(input.kind, asOf)
			.filter((entity) => [...wanted].every((tag) => entity.tags.includes(tag)))
			.filter((entity) => input.after === undefined || compareCodePoints(entity.name, input.after) > 0)
			.sort((a, b) => compareCodePoints(a.name, b.name));
		const entries: EntityEnvelope[] = [];
		let bytes = 2;
		for (const entity of matches) {
			const size = canonicalSize(entity as unknown as JsonValue) + (entries.length > 0 ? 1 : 0);
			if (bytes + size > LIMITS.pageBytes) break;
			bytes += size;
			entries.push(cloneValue(entity));
		}
		const more = entries.length < matches.length;
		return { outcome: "answered", answer: { position: asOf, entries, next: more ? (entries[entries.length - 1] as EntityEnvelope).name : null } };
	}

	historyBound(): StoreOutcome<HistoryBoundAnswer> {
		this.#alive();
		return { outcome: "answered", answer: { position: this.state.position, historyMs: this.historyMs } };
	}
}

/** What a write that passed every check would change. */
interface Plan {
	position: number;
	atMs: number;
	at: string;
	id: string;
	entity: EntityEnvelope | null;
	answer: WriteAnswer;
}

const utf8Encoder = new TextEncoder();

/** Size in UTF-8 bytes of a plain JSON value written in SD4's canonical form. */
function canonicalSize(value: JsonValue): number {
	return utf8ByteLength(toCanonicalJson(value));
}

/** A write's digest (EM7): SHA-256 over the canonical JSON of the input as received, the operation and the writer. */
export function writeDigest(operation: string, input: JsonValue, writer: string): string {
	return sha256Hex(utf8Encoder.encode(toCanonicalJson({ input, operation, writer })));
}

/** Snapshots a caller's input once through shape-check's `snapshotJson` (SD8), or throws a TypeError. */
function snapshotInput(input: unknown): JsonValue {
	const snap = snapshotJson(input);
	if (!snap.ok) throw new TypeError("a store input must be a JSON value");
	return snap.value;
}

/** A mutable deep copy of a validated record or answer (<27 levels), preserving `__proto__` own data properties. */
function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

/**
 * Reads what a storage port's `load()` returns, or throws, as plain data through shape-check's `readPlainJson`
 * and `observePromises` (zorg's D54, D55; Delta 2, D2-E1): any throw, non-plain value, getter, inherited
 * property, symbol or promise is refused as `log-corrupt` with zero getter calls and zero unhandled rejections.
 */
function readStorageLoad(storage: StoragePort): { ok: true; records: readonly LoadedRecord[] } | { ok: false; fault: { code: "log-corrupt" | "log-unwritable"; line: number | null; message: string } } {
	const corrupt = (line: number | null, message: string) => ({ ok: false as const, fault: { code: "log-corrupt" as const, line, message } });
	let raw: unknown;
	try {
		raw = storage.load();
	} catch (err) {
		observePromises(err);
		return corrupt(null, "the storage port's load threw");
	}
	const plain = readPlainJson(raw);
	if (!plain.ok || !isJsonObject(plain.value)) return corrupt(null, "the storage port's load did not return a plain JSON object");
	const top = plain.value;
	if (top.ok === false) {
		const keys = Object.keys(top);
		if (keys.length !== 2 || !Object.hasOwn(top, "fault") || !isJsonObject(top.fault)) return corrupt(null, "the storage port's load returned a malformed fault");
		const fault = top.fault;
		const fkeys = Object.keys(fault);
		const validLine = fault.line === null || (typeof fault.line === "number" && Number.isSafeInteger(fault.line) && fault.line >= 1);
		if (fkeys.length !== 3 || (fault.code !== "log-corrupt" && fault.code !== "log-unwritable") || !validLine || typeof fault.message !== "string") {
			return corrupt(null, "the storage port's load returned a malformed fault");
		}
		return { ok: false, fault: { code: fault.code, line: fault.line as number | null, message: fault.message } };
	}
	if (top.ok !== true || Object.keys(top).length !== 2 || !Array.isArray(top.records)) return corrupt(null, "the storage port's load did not return { ok: true, records }");
	const records: LoadedRecord[] = [];
	for (const entry of top.records) {
		if (!isJsonObject(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "line") || !Object.hasOwn(entry, "record") || typeof entry.line !== "number" || !Number.isSafeInteger(entry.line) || entry.line < 1) {
			return corrupt(null, "the storage port's load returned a malformed record entry");
		}
		records.push({ line: entry.line, record: entry.record });
	}
	return { ok: true, records };
}

function requireWrite(write: WriteContext): void {
	if (write === null || typeof write !== "object" || typeof write.writer !== "string" || typeof write.writeId !== "string") {
		throw new TypeError("a write needs { writer, writeId }, each a string");
	}
}

function targetRefusal(target: { id?: string; kind?: string; name?: string }): StoreRefusal | undefined {
	const names = Object.keys(target).filter((name) => (target as JsonObject)[name] !== undefined).sort().join(",");
	return names === "id" || names === "kind,name" ? undefined : storeRefusal("invalid-target");
}

function revisionRefusal(expected: number | undefined, current: number): StoreRefusal | undefined {
	return expected !== undefined && expected !== current ? storeRefusal("revision-moved", {}, { expected, current }) : undefined;
}

// too-many-tags, then invalid-tag, then duplicate-tag, the first tag that fails being the one named.
function tagRefusal(tags: string[]): StoreRefusal | undefined {
	if (tags.length > LIMITS.tags) return storeRefusal("too-many-tags", {}, { count: tags.length, limit: LIMITS.tags });
	for (const tag of tags) if (!TAG_PATTERN.test(tag)) return storeRefusal("invalid-tag", { tag });
	const seen = new Set<string>();
	for (const tag of tags) {
		if (seen.has(tag)) return storeRefusal("duplicate-tag", { tag });
		seen.add(tag);
	}
	return undefined;
}

function sortTags(tags: string[]): string[] {
	return [...tags].sort(compareCodePoints);
}

