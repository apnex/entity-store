/**
 * The store: entities of the kinds an application gives it, in one order of changes (EM1 to EM10, EM15),
 * the changes after a position the store still holds (EM16), and a narrowed set followed from such a position,
 * with a wait for the next change (EM17).
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
import { compareCodePoints, isJsonObject, NOTE_LIMITS, recoverLog, type RecoveredState } from "./change-log.js";
import { requireChangeWriteShapes, requireInputShape } from "./operation-inputs.js";
import { sha256Hex } from "./sha256.js";
import { cutTo128, storeRefusal } from "./store-refusal.js";
import type {
	ChangeAnswer,
	ChangeInput,
	ChangeItem,
	ChangeRecord,
	ChangeWrite,
	ChangeWriteAnswer,
	ChangesAnswer,
	ChangesInput,
	ClockPort,
	CreateInput,
	DeleteAnswer,
	DeleteInput,
	EntityAnswer,
	EntityEnvelope,
	EntityStore,
	FindAnswer,
	FindInput,
	FollowAnswer,
	FollowEvent,
	FollowInput,
	FollowItem,
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
	WaitOptions,
	WriteAnswer,
	WriteContext,
	WriteOperation,
	WriteRecord,
} from "./store-types.js";

/** EM1's name pattern. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** EM2's tag pattern. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}$/;

/** The limits the target states (EM2, EM7, EM8, EM10, EM16). */
export const LIMITS = Object.freeze({
	tags: 32,
	/** EM7's bound on a writer, in Unicode code points, so every change fits a page of `changes` (zorg's D65). */
	writerCodePoints: 1024,
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
	/** A change's writes, at most (D4, D5). */
	changeWrites: 2000,
	/** A change record's canonical JSON, at most, so a page holding it stays within a 16 MiB carrier (D4, D5). */
	changeBytes: 8_388_608,
	/** A change's note, at most, in levels and in bytes of canonical UTF-8 JSON (D4, D5). */
	noteDepth: NOTE_LIMITS.depth,
	noteBytes: NOTE_LIMITS.bytes,
});

type Judge = (body: JsonValue) => readonly ShapeMisfit[];

/**
 * The state a write is judged against: the store's own for a single operation, or the store's as the writes before
 * it in a change leave it (D4, D5), with the earlier write, if any, of the change that targets the same entity.
 */
interface EntityView {
	resolve(target: { id?: string; kind?: string; name?: string }): EntityEnvelope | undefined;
	nameHolder(kind: string, name: string): string | undefined;
	earlierWrite(target: { id?: string; kind?: string; name?: string }): { id: string; index: number } | undefined;
}

/** Opens a store over a storage port, recovering every record the port holds, or refuses naming the reason. */
export function openEntityStore(options: StoreOptions): StoreOpening {
	if (options === null || typeof options !== "object") throw new TypeError("openEntityStore needs its options");
	const { storage, clock, historyMs, maxEntityBytes, kinds } = options;
	if (!storage || typeof storage.load !== "function" || typeof storage.append !== "function") throw new TypeError("openEntityStore needs a storage port with load and append");
	if (storage.compact !== undefined && typeof storage.compact !== "function") throw new TypeError("openEntityStore's storage.compact must be a function when given");
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
	const state = recovered.state;
	if (state.latestAt !== Number.NEGATIVE_INFINITY) {
		const advanced = state.forgetBefore(state.latestAt - historyMs);
		if (advanced || state.timeRecordCount >= 2) {
			try {
				storage.compact?.(state.compactedRecords());
			} catch (error) {
				observePromises(error);
				return refuse("log-unwritable", `the change log could not be compacted at opening: ${(error as Error)?.message ?? String(error)}`, { line: null });
			}
		}
	}

	return { opened: true, store: new Store(storage, clock, historyMs, maxEntityBytes, judges, state) };
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

/** A wait of `waitForChange` (EM17), held only while it waits. */
interface Wait {
	readonly after: number;
	/** Settles it, dropping it and its signal's listener first. */
	settle(position: number | undefined, error?: unknown): void;
}

class Store implements EntityStore {
	#stopped: unknown = undefined;
	#isStopped = false;
	/** The waits of `waitForChange` still waiting (EM17). */
	readonly #waits = new Set<Wait>();
	/** The store's own state, as a single operation judges against it. */
	readonly #stateView: EntityView = {
		resolve: (target) => this.state.resolve(target),
		nameHolder: (kind, name) => this.state.names.get(kind)?.get(name),
		earlierWrite: () => undefined,
	};

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
			// Every wait rejects with the store's store-stopped error (EM17).
			for (const wait of [...this.#waits]) wait.settle(undefined, stoppedError(cause));
			throw stoppedError(cause);
		}
	}

	#compact(): void {
		const records = this.state.compactedRecords();
		try {
			this.storage.compact?.(records);
		} catch (cause) {
			this.#isStopped = true;
			this.#stopped = cause;
			// Every wait rejects with the store's store-stopped error (EM15, EM17).
			for (const wait of [...this.#waits]) wait.settle(undefined, stoppedError(cause));
			throw stoppedError(cause);
		}
	}

	#forgetExpired(): void {
		if (this.state.latestAt === Number.NEGATIVE_INFINITY) return;
		const advanced = this.state.forgetBefore(this.state.latestAt - this.historyMs);
		if (advanced || this.state.timeRecordCount >= 2) this.#compact();
	}

	/** Resolves every wait whose `after` the store's position has passed, before the write returns (EM17). */
	#wake(): void {
		const position = this.state.position;
		for (const wait of [...this.#waits]) if (position > wait.after) wait.settle(position);
	}

	// Before any decision about retention, the store's time reaches the change log (EM8).
	#timeForDecision(now: number): number {
		if (now > this.state.latestAt) {
			const at = iso(now);
			this.#append({ type: "time", at });
			this.state.applyTime(at, now);
			this.#forgetExpired();
		}
		return now;
	}

	#within(at: number, now: number): boolean {
		return now - at < this.historyMs;
	}

	checkRepeat(operation: WriteOperation, input: CreateInput | UpdateInput | DeleteInput, write: WriteContext): RepeatCheck;
	checkRepeat(operation: "change", input: ChangeInput, write: WriteContext): RepeatCheck;
	checkRepeat(operation: WriteOperation | "change", input: CreateInput | UpdateInput | DeleteInput | ChangeInput, write: WriteContext): RepeatCheck {
		this.#alive();
		if (operation === "change") {
			// A change whose note is not plain JSON gives no request to recognise, and the change refuses it (D4, D5).
			const read = readChangeInput(input);
			requireWrite(write);
			const clock = this.#now();
			if (read.note.given && !read.note.plain) return { repeat: "none" };
			return this.#checkRepeat("change", changeRequest(read), write, clock);
		}
		const json = snapshotInput(input);
		requireInputShape(operation, json);
		requireWrite(write);
		return this.#checkRepeat(operation, json, write, this.#now());
	}

	// `clock` is the store's time read once for the call, so a clock outside EM8's range has already thrown.
	#checkRepeat(operation: WriteOperation | "change", input: JsonValue, write: WriteContext, clock: number): RepeatCheck {
		const remembered = this.state.writes.get(write.writeId);
		if (remembered === undefined) return { repeat: "none" };
		const now = this.#timeForDecision(clock);
		if (!this.#within(remembered.at, now)) return { repeat: "none" };
		if (remembered.digest !== writeDigest(operation, input, write.writer)) return { repeat: "identity-reused", refusal: storeRefusal("identity-reused", { writeId: write.writeId }) };
		return { repeat: "recognised", answer: cloneValue(remembered.answer) };
	}

	create(input: CreateInput, write: WriteContext): StoreOutcome<EntityAnswer> {
		return this.#write("create", input, write, (now, snap) => this.#planCreate(snap as unknown as CreateInput, write, now, this.#stateView, 1)) as StoreOutcome<EntityAnswer>;
	}

	update(input: UpdateInput, write: WriteContext): StoreOutcome<EntityAnswer> {
		return this.#write("update", input, write, (now, snap) => this.#planUpdate(snap as unknown as UpdateInput, write, now, this.#stateView)) as StoreOutcome<EntityAnswer>;
	}

	delete(input: DeleteInput, write: WriteContext): StoreOutcome<DeleteAnswer> {
		return this.#write("delete", input, write, (now, snap) => this.#planDelete(snap as unknown as DeleteInput, now, this.#stateView)) as StoreOutcome<DeleteAnswer>;
	}

	/**
	 * A change of many writes (D4, D5): its input's shape and each write's, thrown; then the note's plainness, the
	 * identity, the writer, the count, the note's bounds and the expected position; then each write in order, judged
	 * as its single operation judges it against the state the writes before it leave, one refusal refusing the whole
	 * change and naming the write's index; then the record's size; then the change, appended before it is seen.
	 */
	change(rawInput: ChangeInput, write: WriteContext): StoreOutcome<ChangeAnswer> {
		this.#alive();
		const read = readChangeInput(rawInput);
		requireWrite(write);
		const now = this.#now();
		const note = read.note;
		if (note.given && !note.plain) return { outcome: "refused", refusal: storeRefusal("note-not-plain") };
		const kept = note.given && note.plain ? { value: note.value } : undefined;
		const input = changeRequest(read);
		const repeat = this.#checkRepeat("change", input, write, now);
		if (repeat.repeat === "recognised") return { outcome: "answered", answer: repeat.answer as ChangeAnswer };
		if (repeat.repeat === "identity-reused") return { outcome: "refused", refusal: repeat.refusal };
		const writerLength = codePointLength(write.writer);
		if (writerLength > LIMITS.writerCodePoints) return { outcome: "refused", refusal: storeRefusal("writer-too-long", {}, { length: writerLength, limit: LIMITS.writerCodePoints }) };
		const writes = read.rest.writes as unknown as ChangeWrite[];
		if (writes.length === 0) return { outcome: "refused", refusal: storeRefusal("empty-change") };
		if (writes.length > LIMITS.changeWrites) return { outcome: "refused", refusal: storeRefusal("too-many-writes", {}, { count: writes.length, limit: LIMITS.changeWrites }) };
		if (kept !== undefined) {
			const depth = nestingDepth(kept.value);
			if (depth > LIMITS.noteDepth) return { outcome: "refused", refusal: storeRefusal("note-too-deep", {}, { depth, limit: LIMITS.noteDepth }) };
			const bytes = canonicalSize(kept.value);
			if (bytes > LIMITS.noteBytes) return { outcome: "refused", refusal: storeRefusal("note-too-large", {}, { bytes, limit: LIMITS.noteBytes }) };
		}
		const expected = read.rest.expectedPosition;
		if (typeof expected === "number" && expected !== this.state.position) {
			return { outcome: "refused", refusal: storeRefusal("position-moved", {}, { expected, current: this.state.position }) };
		}

		const scratch = new ChangeScratch(this.state);
		const answers: ChangeWriteAnswer[] = [];
		const records: WriteRecord[] = [];
		const next = this.#next(now);
		for (const [index, item] of writes.entries()) {
			const planned = item.operation === "create" ? this.#planCreate(item.input, write, now, scratch, index + 1)
				: item.operation === "update" ? this.#planUpdate(item.input, write, now, scratch)
				: this.#planDelete(item.input, now, scratch);
			if ("part" in planned) return { outcome: "refused", refusal: { ...planned, details: { ...planned.details, index } } };
			scratch.apply(planned.id, index, planned.previous, planned.entity);
			answers.push("deleted" in planned.answer ? { deleted: planned.answer.deleted } : { entity: (planned.answer as EntityAnswer).entity });
			records.push({ operation: item.operation, id: planned.id, entity: planned.entity });
		}
		const answer: ChangeAnswer = { position: next.position, writes: answers };
		const record: ChangeRecord = {
			type: "change",
			position: next.position,
			at: next.at,
			writer: write.writer,
			writeId: write.writeId,
			digest: writeDigest("change", input, write.writer),
			answer,
			writes: records,
		};
		if (kept !== undefined) record.note = kept.value;
		const bytes = changeRecordSize(record, answer);
		if (bytes > LIMITS.changeBytes) return { outcome: "refused", refusal: storeRefusal("change-too-large", {}, { bytes, limit: LIMITS.changeBytes }) };
		this.#append(record);
		this.state.apply(record, next.atMs);
		this.#forgetExpired();
		this.#wake();
		return { outcome: "answered", answer: cloneValue(answer) };
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
		// writer-too-long comes after the identity (EM9), so a repeat of a change recovered from a log written
		// before the bound is still recognised above.
		const writerLength = codePointLength(write.writer);
		if (writerLength > LIMITS.writerCodePoints) return { outcome: "refused", refusal: storeRefusal("writer-too-long", {}, { length: writerLength, limit: LIMITS.writerCodePoints }) };
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
		this.#forgetExpired();
		this.#wake();
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

	// `place` is the write's place in its change, counting from 1, and 1 for a single create (D4, D5).
	#planCreate(input: CreateInput, write: WriteContext, now: number, view: EntityView, place: number): Plan | StoreRefusal {
		const refusal = this.#unknownKind(input.kind)
			?? this.#nameRefusal(input.kind, input.name, undefined, view)
			?? tagRefusal(input.tags);
		if (refusal) return refusal;
		const next = this.#next(now);
		const id = `e${next.position}.${place}`;
		const stamp = { position: next.position, at: next.at, writer: write.writer };
		const entity: EntityEnvelope = { id, kind: input.kind, name: input.name, tags: sortTags(input.tags), body: input.body, revision: 1, created: stamp, changed: { ...stamp } };
		return this.#envelopeRefusal(entity) ?? { ...next, id, previous: null, entity, answer: { position: next.position, entity } };
	}

	// duplicate-target, which only a change can meet, comes once the target is known to name one entity (D4, D5).
	#duplicateRefusal(target: { id?: string; kind?: string; name?: string }, view: EntityView): StoreRefusal | undefined {
		const earlier = view.earlierWrite(target);
		return earlier === undefined ? undefined : storeRefusal("duplicate-target", {}, { earlierIndex: earlier.index, id: earlier.id });
	}

	#planUpdate(input: UpdateInput, write: WriteContext, now: number, view: EntityView): Plan | StoreRefusal {
		const target = input.target;
		let refusal = this.#unknownKind(target.kind) ?? targetRefusal(target);
		if (refusal) return refusal;
		if (input.name === undefined && input.tags === undefined && input.body === undefined) return storeRefusal("empty-update");
		refusal = this.#duplicateRefusal(target, view);
		if (refusal) return refusal;
		const current = view.resolve(target);
		if (current === undefined) return storeRefusal("not-found", { target: target as JsonObject });
		refusal = revisionRefusal(input.expectedRevision, current.revision)
			?? (input.name !== undefined ? this.#nameRefusal(current.kind, input.name, current.id, view) : undefined)
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
		return this.#envelopeRefusal(entity) ?? { ...next, id: entity.id, previous: current, entity, answer: { position: next.position, entity } };
	}

	#planDelete(input: DeleteInput, now: number, view: EntityView): Plan | StoreRefusal {
		const target = input.target;
		let refusal = this.#unknownKind(target.kind) ?? targetRefusal(target) ?? this.#duplicateRefusal(target, view);
		if (refusal) return refusal;
		const current = view.resolve(target);
		if (current === undefined) return storeRefusal("not-found", { target: target as JsonObject });
		refusal = revisionRefusal(input.expectedRevision, current.revision);
		if (refusal) return refusal;
		const next = this.#next(now);
		const deleted = { id: current.id, kind: current.kind, name: current.name, revision: current.revision + 1 };
		return { ...next, id: current.id, previous: current, entity: null, answer: { position: next.position, deleted } };
	}

	// invalid-name, then name-taken: a create or rename to a name another entity of the kind holds.
	#nameRefusal(kind: string, name: string, self: string | undefined, view: EntityView): StoreRefusal | undefined {
		if (!NAME_PATTERN.test(name)) return storeRefusal("invalid-name", { name });
		const holder = view.nameHolder(kind, name);
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
			const clock = this.#now();
			if (asOf < this.state.forgottenThrough) return { outcome: "refused", refusal: storeRefusal("position-not-held", {}, { position: asOf }) };
			const now = this.#timeForDecision(clock);
			if (asOf < this.state.forgottenThrough || !this.#within(this.state.changeAt(asOf + 1), now)) {
				return { outcome: "refused", refusal: storeRefusal("position-not-held", {}, { position: asOf }) };
			}
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

	#sizesAt(position: number): number[] {
		let sizes = this.state.itemSizes.get(position);
		if (sizes === undefined) {
			sizes = (this.state.changeItems.get(position) as ChangeItem[]).map((item) => canonicalSize(item as unknown as JsonValue));
			this.state.itemSizes.set(position, sizes);
		}
		return sizes;
	}

	// One page of the changes after `since` (EM16): `since` checked as a find's `asOf` is (EM8, EM10), then the
	// items of whole changes up to 524288 bytes of canonical JSON in `changes`, brackets and commas counted,
	// and the items of at least one change while any remains.
	changes(rawInput: ChangesInput): StoreOutcome<ChangesAnswer> {
		this.#alive();
		const input = snapshotInput(rawInput) as unknown as ChangesInput;
		requireInputShape("changes", input);
		const current = this.state.position;
		const since = input.since;
		if (since < 0 || since > current) return { outcome: "refused", refusal: storeRefusal("invalid-position", {}, { position: since, current }) };
		if (since < current) {
			const clock = this.#now();
			if (since < this.state.forgottenThrough) return { outcome: "refused", refusal: storeRefusal("position-not-held", {}, { position: since }) };
			const now = this.#timeForDecision(clock);
			if (since < this.state.forgottenThrough || !this.#within(this.state.changeAt(since + 1), now)) {
				return { outcome: "refused", refusal: storeRefusal("position-not-held", {}, { position: since }) };
			}
		}
		const changes: ChangeItem[] = [];
		let bytes = 2;
		let last = since;
		for (let position = since + 1; position <= current; position++) {
			// Every item but the page's first is preceded by a comma.
			let size = changes.length === 0 ? -1 : 0;
			for (const itemSize of this.#sizesAt(position)) size += itemSize + 1;
			if (last !== since && bytes + size > LIMITS.pageBytes) break;
			bytes += size;
			for (const item of this.state.changeItems.get(position) as ChangeItem[]) changes.push(cloneValue(item));
			last = position;
		}
		return { outcome: "answered", answer: { position: current, changes, next: last < current ? last : null } };
	}

	// One page of `follow` (EM17): the stopped store, then the input's shape, then the kind, then `since` as
	// `changes` checks it; then the changes after `since` taken in order, each whole, a change giving no item
	// never stopping the page, and the page stopping before the first change giving items that does not fit
	// within 524288 bytes once it holds any; `through` is the last change taken.
	follow(rawInput: FollowInput): StoreOutcome<FollowAnswer> {
		this.#alive();
		const input = snapshotInput(rawInput) as unknown as FollowInput;
		requireInputShape("follow", input);
		const unknown = this.#unknownKind(input.kind);
		if (unknown) return { outcome: "refused", refusal: unknown };
		const current = this.state.position;
		const since = input.since;
		if (since < 0 || since > current) return { outcome: "refused", refusal: storeRefusal("invalid-position", {}, { position: since, current }) };
		if (since < current) {
			const clock = this.#now();
			if (since < this.state.forgottenThrough) return { outcome: "refused", refusal: storeRefusal("position-not-held", {}, { position: since }) };
			const now = this.#timeForDecision(clock);
			if (since < this.state.forgottenThrough || !this.#within(this.state.changeAt(since + 1), now)) {
				return { outcome: "refused", refusal: storeRefusal("position-not-held", {}, { position: since }) };
			}
		}
		// The tags are a set and not judged: more than 32 distinct tags, or one no entity can carry, match nothing (EM2).
		const wanted = [...new Set(input.tags ?? [])];
		const inSet = (entity: EntityEnvelope | null): boolean =>
			entity !== null && entity.kind === input.kind && wanted.length <= LIMITS.tags && wanted.every((tag) => entity.tags.includes(tag));
		const changes: FollowItem[] = [];
		let bytes = 2;
		let through = since;
		for (let position = since + 1; position <= current; position++) {
			const items = this.#followItems(position, input.kind, inSet);
			if (items.length > 0) {
				// Every item but the page's first is preceded by a comma.
				let size = changes.length === 0 ? -1 : 0;
				for (const item of items) size += canonicalSize(item as unknown as JsonValue) + 1;
				if (changes.length > 0 && bytes + size > LIMITS.pageBytes) break;
				bytes += size;
				for (const item of items) changes.push(cloneValue(item));
			}
			through = position;
		}
		return { outcome: "answered", answer: { position: current, through, changes } };
	}

	/**
	 * The items one change gives a follow (EM17): for each of its writes whose entity is of `kind`, in order, the
	 * entity's state before the whole change compared with its state after it. The identity, time and writer come
	 * from the items `changes` already keeps for the change - an envelope's `changed`, or what a delete left - so
	 * following keeps nothing more. The first item given carries the change's note, which `changes` keeps on the
	 * change's first item, when it has one (D4, D5).
	 */
	#followItems(position: number, kind: string, inSet: (entity: EntityEnvelope | null) => boolean): FollowItem[] {
		const items: FollowItem[] = [];
		const kept = this.state.changeItems.get(position) as ChangeItem[];
		for (const written of kept) {
			const stamp = "deleted" in written
				? { id: written.deleted.id, at: written.at, writer: written.writer }
				: { id: written.id, at: written.changed.at, writer: written.changed.writer };
			const id = stamp.id;
			const { before, after } = this.state.aroundChange(id, position);
			if ((before ?? after)?.kind !== kind) continue;
			const was = inSet(before);
			const is = inSet(after);
			const event: FollowEvent | undefined = !was && is ? "entering" : was && is ? "changing" : was && !is ? "leaving" : undefined;
			if (event === undefined) continue;
			items.push({ event, position, at: stamp.at, writer: stamp.writer, id, entity: after });
		}
		const first = kept[0];
		if (items.length > 0 && first !== undefined && Object.hasOwn(first, "note")) items[0] = { ...(items[0] as FollowItem), note: first.note as JsonValue };
		return items;
	}

	// A wait for the next change (EM17): the stopped store, then the arguments, then the signal, then the position.
	waitForChange(after: number, options?: WaitOptions): Promise<number> {
		this.#alive();
		if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) throw new TypeError("waitForChange needs after, a whole number from 0 to 9007199254740991");
		if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) throw new TypeError("waitForChange's options are omitted or an object holding an optional signal");
		const signal: unknown = options?.signal;
		if (signal !== undefined) {
			const candidate = signal as { aborted?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
			if (signal === null || typeof signal !== "object" || typeof candidate.aborted !== "boolean" || typeof candidate.addEventListener !== "function" || typeof candidate.removeEventListener !== "function") {
				throw new TypeError("waitForChange's signal must be an abort signal: aborted a boolean, with addEventListener and removeEventListener");
			}
		}
		const abort = signal as AbortSignal | undefined;
		if (abort?.aborted === true) return Promise.reject(abort.reason);
		if (this.state.position > after) return Promise.resolve(this.state.position);
		let resolve: (position: number) => void = () => undefined;
		let reject: (error: unknown) => void = () => undefined;
		const promise = new Promise<number>((res, rej) => { resolve = res; reject = rej; });
		let settled = false;
		const onAbort = (): void => wait.settle(undefined, abort?.reason);
		const wait: Wait = {
			after,
			settle: (position, error) => {
				if (settled) return;
				settled = true;
				this.#waits.delete(wait);
				try {
					abort?.removeEventListener("abort", onAbort);
				} catch {
					// A signal that cannot remove its listener leaves it to find the wait settled.
				}
				if (position === undefined) reject(error);
				else resolve(position);
			},
		};
		// The wait is held before its listener is added, so a signal that fires as the listener is added settles,
		// and drops, a wait already held. A throw from adding the listener drops the wait and removes the listener,
		// which the signal may have added before it threw, and the promise, never returned, is observed, so a
		// rejection the signal gave it as it fired is not left unhandled; the throw is then thrown.
		this.#waits.add(wait);
		try {
			abort?.addEventListener("abort", onAbort, { once: true });
		} catch (error) {
			settled = true;
			this.#waits.delete(wait);
			try {
				abort?.removeEventListener("abort", onAbort);
			} catch {
				// A signal that cannot remove its listener leaves it to find the wait settled.
			}
			promise.catch(() => undefined);
			throw error;
		}
		// A signal that fired while it was adding the listener, before it added it, never calls it: the wait rejects
		// with its reason now. A wait settled while its listener was being added - by a change, its signal or a failed
		// append made as the signal added it - removed the listener before it was added; it is removed again now.
		if (!settled && (abort as { readonly aborted: boolean } | undefined)?.aborted === true) wait.settle(undefined, abort?.reason);
		if (settled) {
			try {
				abort?.removeEventListener("abort", onAbort);
			} catch {
				// A signal that cannot remove its listener leaves it to find the wait settled.
			}
		}
		return promise;
	}
}

/** What a write that passed every check would change, and the entity's state before it. */
interface Plan {
	position: number;
	atMs: number;
	at: string;
	id: string;
	previous: EntityEnvelope | null;
	entity: EntityEnvelope | null;
	answer: WriteAnswer;
}

/**
 * The store's state as the writes of a change judged so far would leave it (D4, D5), held apart from the store, so
 * a change refused at any write leaves the store untouched: each entity those writes wrote, each name they freed or
 * took, and the place in the change of the write that wrote each entity.
 */
class ChangeScratch implements EntityView {
	readonly #entities = new Map<string, EntityEnvelope | null>();
	readonly #names = new Map<string, Map<string, string | null>>();
	readonly #written = new Map<string, number>();

	constructor(private readonly state: RecoveredState) {}

	nameHolder(kind: string, name: string): string | undefined {
		const kindNames = this.#names.get(kind);
		if (kindNames?.has(name)) return kindNames.get(name) ?? undefined;
		return this.state.names.get(kind)?.get(name);
	}

	#idOf(target: { id?: string; kind?: string; name?: string }): string | undefined {
		return target.id ?? this.nameHolder(target.kind as string, target.name as string);
	}

	resolve(target: { id?: string; kind?: string; name?: string }): EntityEnvelope | undefined {
		const id = this.#idOf(target);
		if (id === undefined) return undefined;
		return this.#entities.has(id) ? this.#entities.get(id) ?? undefined : this.state.resolve({ id });
	}

	earlierWrite(target: { id?: string; kind?: string; name?: string }): { id: string; index: number } | undefined {
		const id = this.#idOf(target);
		const index = id === undefined ? undefined : this.#written.get(id);
		return id === undefined || index === undefined ? undefined : { id, index };
	}

	/** Takes a write that passed every check: the name its entity held is freed, then the name it leaves is taken. */
	apply(id: string, index: number, previous: EntityEnvelope | null, entity: EntityEnvelope | null): void {
		const names = (kind: string): Map<string, string | null> => {
			let kindNames = this.#names.get(kind);
			if (kindNames === undefined) this.#names.set(kind, (kindNames = new Map()));
			return kindNames;
		};
		if (previous !== null) names(previous.kind).set(previous.name, null);
		if (entity !== null) names(entity.kind).set(entity.name, id);
		this.#entities.set(id, entity);
		this.#written.set(id, index);
	}
}

/** How a change's note was given: not at all (or as undefined), as plain JSON, or as something else (D4, D5). */
type NoteReading = { given: false } | { given: true; plain: false } | { given: true; plain: true; value: JsonValue };

/** A change's input as read: everything but the note, snapshotted and shape-checked, and the note as read. */
interface ChangeReading {
	rest: JsonObject;
	note: NoteReading;
}

/**
 * Reads a change's input (D4, D5). The note is read through shape-check's `readPlainJson`, from its own data
 * property, so none of the application's code runs to read it; an accessor or non-enumerable `note` is not plain.
 * Everything else is snapshotted as every input is (SD8), and judged against change's shape and each write's input
 * against its operation's shape, a misfit thrown as a TypeError. A note that is not plain is not thrown: the change
 * refuses it, once the input's shape is known to be right.
 */
function readChangeInput(raw: unknown): ChangeReading {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("the change input must be an object holding writes");
	const proto: unknown = Object.getPrototypeOf(raw);
	if (proto !== Object.prototype && proto !== null) throw new TypeError("a store input must be a JSON value");
	let note: NoteReading = { given: false };
	const descriptor = Object.getOwnPropertyDescriptor(raw, "note");
	if (descriptor !== undefined) {
		if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) note = { given: true, plain: false };
		else if (descriptor.value !== undefined) {
			const reading = readPlainJson(descriptor.value);
			note = reading.ok ? { given: true, plain: true, value: canonicalForm(reading.value) } : { given: true, plain: false };
		}
	}
	const rest: { [name: string]: unknown } = {};
	for (const name of Object.keys(raw)) {
		if (name === "note") continue;
		Object.defineProperty(rest, name, { value: (raw as { [name: string]: unknown })[name], enumerable: true, writable: true, configurable: true });
	}
	const json = snapshotInput(rest);
	requireInputShape("change", json);
	requireChangeWriteShapes((json as JsonObject).writes as unknown as ChangeWrite[]);
	return { rest: json as JsonObject, note };
}

/** The whole request a change's digest is of: its writes, its expected position when given, and its note when given. */
function changeRequest(read: ChangeReading): JsonObject {
	return read.note.given && read.note.plain ? { ...read.rest, note: read.note.value } : read.rest;
}

/** A plain JSON value rebuilt from its canonical JSON (SD4), so its members are held in code-point order. */
function canonicalForm(value: JsonValue): JsonValue {
	return JSON.parse(toCanonicalJson(value)) as JsonValue;
}

const utf8Encoder = new TextEncoder();

/** Size in UTF-8 bytes of a plain JSON value written in SD4's canonical form. */
function canonicalSize(value: JsonValue): number {
	return utf8ByteLength(toCanonicalJson(value));
}

/**
 * The size in UTF-8 bytes of a change record's canonical JSON (D4, D5), measured one write at a time, so a change far
 * beyond the bound is refused rather than made into one string larger than a runtime holds: the record with both
 * lists of writes empty, then each item of each list, and the commas between them.
 */
function changeRecordSize(record: ChangeRecord, answer: ChangeAnswer): number {
	let bytes = canonicalSize({ ...record, answer: { ...answer, writes: [] }, writes: [] } as unknown as JsonValue);
	for (const item of answer.writes) bytes += canonicalSize(item as unknown as JsonValue);
	for (const item of record.writes) bytes += canonicalSize(item as unknown as JsonValue);
	return bytes + 2 * (record.writes.length - 1);
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

/** The number of Unicode code points in a string, as it iterates: a surrogate pair is one, and a lone surrogate one (EM7). */
function codePointLength(text: string): number {
	let count = 0;
	for (const _ of text) count++;
	return count;
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

