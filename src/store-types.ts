/**
 * The types of entity-store's public surface: the envelope (EM5), the operations' inputs and answers
 * (EM10), the refusal record (EM9), the change log's records (EM15), and the two ports an application
 * supplies - storage and the clock.
 */
import type { JsonInput, JsonObject, JsonValue, ShapeMisfit, ShapeProblem } from "@apnex/shape-check";

export type { JsonObject, JsonValue } from "@apnex/shape-check";

/** When and by whom a change was made: its position, its time in UTC to the millisecond, and the writer named (EM5). */
export interface ChangeStamp {
	position: number;
	at: string;
	writer: string;
}

/** The envelope every entity is kept and read in (EM5). */
export interface EntityEnvelope {
	id: string;
	kind: string;
	name: string;
	tags: string[];
	body: JsonValue;
	revision: number;
	created: ChangeStamp;
	changed: ChangeStamp;
}

/** A target: exactly an identity, or exactly a kind and a name (EM9, `invalid-target`). */
export type EntityTarget = { id: string } | { kind: string; name: string };

/** The input of `create` (EM10). */
export interface CreateInput {
	kind: string;
	name: string;
	tags: string[];
	body: JsonValue;
}

/** The input of `update` (EM10). */
export interface UpdateInput {
	target: { id?: string; kind?: string; name?: string };
	expectedRevision?: number;
	name?: string;
	tags?: string[];
	body?: JsonValue;
}

/** The input of `delete` (EM10). */
export interface DeleteInput {
	target: { id?: string; kind?: string; name?: string };
	expectedRevision?: number;
}

/** The input of `read` (EM10). */
export interface ReadInput {
	target: { id?: string; kind?: string; name?: string };
}

/** The input of `find` (EM10): a kind, any set of tags, and optionally a name to page after and a position to answer as of. */
export interface FindInput {
	kind: string;
	tags?: string[];
	after?: string;
	asOf?: number;
}

/** The answer to a `create` or an `update`. */
export interface EntityAnswer {
	position: number;
	entity: EntityEnvelope;
}

/** The answer to a `delete`: the position, and the entity's identity, kind, name and final revision. */
export interface DeleteAnswer {
	position: number;
	deleted: { id: string; kind: string; name: string; revision: number };
}

/** The answer to a `read`: the store's position, and the entity or null. */
export interface ReadAnswer {
	position: number;
	entity: EntityEnvelope | null;
}

/** One page of a `find`: its position, the entities matching in name order, and the last name held when more remain. */
export interface FindAnswer {
	position: number;
	entries: EntityEnvelope[];
	next: string | null;
}

/** The answer to `history-bound`. */
export interface HistoryBoundAnswer {
	position: number;
	historyMs: number;
}

/** The answer to a write: the answer of whichever operation it was. */
export type WriteAnswer = EntityAnswer | DeleteAnswer;

/** The codes entity-store refuses a write or read with (EM9), in the order it checks them. */
export type StoreRefusalCode =
	| "identity-reused"
	| "unknown-kind"
	| "invalid-position"
	| "position-not-held"
	| "invalid-target"
	| "empty-update"
	| "not-found"
	| "revision-moved"
	| "invalid-name"
	| "name-taken"
	| "too-many-tags"
	| "invalid-tag"
	| "duplicate-tag"
	| "misfit"
	| "entity-too-large"
	| "entity-too-deep"
	| "unsafe-number";

/** The shared refusal record (EM9): which part refused, why, how to fix it, and the facts its code names. */
export interface StoreRefusal {
	part: "entity-store";
	code: StoreRefusalCode;
	what: string;
	why: string;
	fix: string;
	details: JsonObject;
	misfits?: ShapeMisfit[];
}

/** How a store operation ended: answered with its answer, or refused with the refusal record. */
export type StoreOutcome<A> = { outcome: "answered"; answer: A } | { outcome: "refused"; refusal: StoreRefusal };

/** What the application names for each write: the writer, unchecked, and the write identity its writer supplies (EM7). */
export interface WriteContext {
	writer: string;
	writeId: string;
}

/** Whether a write is a recognised repeat (EM7), as entity-api asks before its policy rules (EM13). */
export type RepeatCheck =
	| { repeat: "none" }
	| { repeat: "recognised"; answer: WriteAnswer }
	| { repeat: "identity-reused"; refusal: StoreRefusal };

/** The operations that write. */
export type WriteOperation = "create" | "update" | "delete";

/** A write within a change record (EM15). */
export interface WriteRecord {
	operation: WriteOperation;
	id: string;
	entity: EntityEnvelope | null;
}

/** A change record (EM15): one or more writes taking one position (D33). */
export interface ChangeRecord {
	type: "change";
	position: number;
	at: string;
	writer: string;
	writeId: string;
	digest: string;
	answer: WriteAnswer;
	writes: WriteRecord[];
}

/** A time record (EM15, EM8): the store's time, appended before a decision about retention; it takes no position. */
export interface TimeRecord {
	type: "time";
	at: string;
}

/** A record of the change log. */
export type LogRecord = ChangeRecord | TimeRecord;

/** A record as a storage port loaded it, with the line it was read from, counting the header as line 1. */
export interface LoadedRecord {
	line: number;
	record: unknown;
}

/** Why a storage port could not give the store its log. */
export interface StorageFault {
	code: "log-corrupt" | "log-unwritable";
	line: number | null;
	message: string;
}

/** What a storage port's `load` gives: every whole record in order, or the fault that stops the store opening. */
export type StorageLoad = { ok: true; records: LoadedRecord[] } | { ok: false; fault: StorageFault };

/**
 * The storage port an application supplies (`storage-port`): `load` gives the records kept so far, once,
 * when the store opens; `append` keeps one record, durably when the port is durable, before it returns,
 * and throws when it cannot.
 */
export interface StoragePort {
	load(): StorageLoad;
	append(record: LogRecord): void;
}

/** The clock port an application supplies: its time in milliseconds since 1970-01-01T00:00:00Z. */
export interface ClockPort {
	now(): number;
}

/** What a store is opened with. */
export interface StoreOptions {
	/** Where the change log is kept. */
	storage: StoragePort;
	/** The application's clock; the store never reads another. */
	clock: ClockPort;
	/** The history bound, in milliseconds, from 1 to 365 days (EM8). */
	historyMs: number;
	/** The largest envelope, in bytes of canonical JSON, from 1 to 262144 (EM10). */
	maxEntityBytes: number;
	/** The kinds, each a name and the shape of its body in shape-check's dialect; no kind is built in. */
	kinds: { readonly [kind: string]: JsonInput };
}

/** Why a store refused to open (EM10, EM15), checked in this order. */
export type OpeningRefusalCode =
	| "invalid-bound"
	| "invalid-size"
	| "invalid-kind-name"
	| "shape-refused"
	| "shape-too-deep"
	| "unsafe-shape"
	| "shape-too-large"
	| "log-corrupt"
	| "log-unwritable";

/** A refusal to open, naming the reason, with shape-check's problems for a refused shape and the line for a log fault. */
export interface OpeningRefusal {
	code: OpeningRefusalCode;
	message: string;
	details: { [name: string]: JsonValue | ShapeProblem[] };
}

/** The result of opening a store. */
export type StoreOpening = { opened: true; store: EntityStore } | { opened: false; refusal: OpeningRefusal };

/** An open store. Every operation runs to completion before the next begins. */
export interface EntityStore {
	create(input: CreateInput, write: WriteContext): StoreOutcome<EntityAnswer>;
	update(input: UpdateInput, write: WriteContext): StoreOutcome<EntityAnswer>;
	delete(input: DeleteInput, write: WriteContext): StoreOutcome<DeleteAnswer>;
	read(input: ReadInput): StoreOutcome<ReadAnswer>;
	find(input: FindInput): StoreOutcome<FindAnswer>;
	historyBound(): StoreOutcome<HistoryBoundAnswer>;
	/** Says whether a write is a recognised repeat, without making it (EM13, step 2). */
	checkRepeat(operation: WriteOperation, input: CreateInput | UpdateInput | DeleteInput, write: WriteContext): RepeatCheck;
}
