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

/** The input of `changes` (EM16): the position after which every change is given. */
export interface ChangesInput {
	since: number;
}

/**
 * The item a delete leaves in `changes` (EM16): what a delete's answer holds, taken from the state the
 * delete's write replaced, then the change's position, time and writer.
 */
export interface DeletedItem {
	deleted: { id: string; kind: string; name: string; revision: number };
	position: number;
	at: string;
	writer: string;
}

/** The note a change carries (D4, D5), on the first of that change's items in `changes` and `follow` only. */
export interface ChangeNote {
	note?: JsonValue;
}

/**
 * One item of `changes` (EM16): the envelope a create or an update left, or what a delete left; the first item of
 * a change carrying a note also holds the note (D4, D5).
 */
export type ChangeItem = (EntityEnvelope | DeletedItem) & ChangeNote;

/**
 * One page of `changes` (EM16): the store's position when it answered, one item for each write of each
 * change it holds, and the position of the last change it holds when more remain.
 */
export interface ChangesAnswer {
	position: number;
	changes: ChangeItem[];
	next: number | null;
}

/** The input of `follow` (EM17): a kind, a set of tags, and the position after which every change is followed. */
export interface FollowInput {
	kind: string;
	tags?: string[];
	since: number;
}

/** What a write did to the set `follow` narrows (EM17). */
export type FollowEvent = "entering" | "changing" | "leaving";

/**
 * One item of `follow` (EM17): the event, the change's position, time and writer, the entity's identity, and the
 * envelope as the change left it, or null when the change left the entity deleted; the first of a change's items in
 * an answer also holds the change's note, when it has one (D4, D5).
 */
export interface FollowItem extends ChangeNote {
	event: FollowEvent;
	position: number;
	at: string;
	writer: string;
	id: string;
	entity: EntityEnvelope | null;
}

/**
 * One page of `follow` (EM17): the store's position when it answered, the position of the last change the page
 * took, and the items of the changes it took.
 */
export interface FollowAnswer {
	position: number;
	through: number;
	changes: FollowItem[];
}

/** The options of `waitForChange` (EM17). */
export interface WaitOptions {
	/** Rejects the wait with its reason when it fires. */
	signal?: AbortSignal;
}

/** The answer to `history-bound`. */
export interface HistoryBoundAnswer {
	position: number;
	historyMs: number;
}

/** One write of a change (D4, D5): an operation and its input, in the form the single operation takes. */
export type ChangeWrite =
	| { operation: "create"; input: CreateInput }
	| { operation: "update"; input: UpdateInput }
	| { operation: "delete"; input: DeleteInput };

/**
 * The input of `change` (D4, D5): 1 to 2,000 writes; optionally the store position its writer last saw; and
 * optionally a note, plain JSON the store never interprets, which an absent or undefined note leaves out.
 */
export interface ChangeInput {
	writes: ChangeWrite[];
	expectedPosition?: number;
	note?: JsonValue;
}

/** What one write of a change answers: the envelope a create or an update left, or what a delete left. */
export type ChangeWriteAnswer = { entity: EntityEnvelope } | { deleted: { id: string; kind: string; name: string; revision: number } };

/** The answer to a `change` (D4, D5): its one position, and each write's answer in the order the writes were given. */
export interface ChangeAnswer {
	position: number;
	writes: ChangeWriteAnswer[];
}

/** The answer to a write: the answer of whichever operation it was, the third variant a `change`'s. */
export type WriteAnswer = EntityAnswer | DeleteAnswer | ChangeAnswer;

/**
 * The codes entity-store refuses a write or read with (EM9), in the order it checks them. A `change` checks
 * `note-not-plain` first, since a note that is not plain JSON gives no request to recognise; then the identity and
 * the writer; then `empty-change`, `too-many-writes`, `note-too-deep`, `note-too-large`, `note-unsafe-number` and
 * `position-moved`; then
 * each write in order as its single operation checks it, with `duplicate-target` after `empty-update`, a refusal of a
 * write naming its `index`; and `change-too-large` last, on the record the change would append (D4, D5).
 */
export type StoreRefusalCode =
	| "note-not-plain"
	| "identity-reused"
	| "writer-too-long"
	| "empty-change"
	| "too-many-writes"
	| "note-too-deep"
	| "note-too-large"
	| "note-unsafe-number"
	| "position-moved"
	| "unknown-kind"
	| "invalid-position"
	| "position-not-held"
	| "invalid-target"
	| "empty-update"
	| "duplicate-target"
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
	| "unsafe-number"
	| "change-too-large";

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

/**
 * What the application names for each write (EM7): the writer, never checked for who it names but refused
 * as `writer-too-long` beyond 1024 code points (zorg's D65), and the write identity its writer supplies.
 */
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

/** A base record at the start of a compacted change log (EM15, D68, D69, BL26). */
export interface BaseRecord {
	type: "base";
	position: number;
	at: string;
	digest: string;
	entities: EntityEnvelope[];
}

/**
 * A change record (EM15): one or more writes taking one position (D33), and the change's note, in canonical form,
 * after every other field when the change has one and absent when it has none, so a record without a note is
 * exactly what 0.1.0 wrote (D4, D5).
 */
export interface ChangeRecord {
	type: "change";
	position: number;
	at: string;
	writer: string;
	writeId: string;
	digest: string;
	answer: WriteAnswer;
	writes: WriteRecord[];
	note?: JsonValue;
}

/** A time record (EM15, EM8): the store's time, appended before a decision about retention; it takes no position. */
export interface TimeRecord {
	type: "time";
	at: string;
}

/** A record of the change log. */
export type LogRecord = BaseRecord | ChangeRecord | TimeRecord;

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
 * and throws when it cannot; `compact`, when present, replaces the active log's records with `records`
 * once the store compacts (EM15, BL26), and throws when it cannot.
 */
export interface StoragePort {
	load(): StorageLoad;
	append(record: LogRecord): void;
	compact?(records: readonly LogRecord[]): void;
}

/** Options for `createFileStoragePort` (EM15, BL26). */
export interface FileStorageOptions {
	/** Optional archive file to which evicted `change` records are appended before compaction replaces `file`. */
	readonly archiveFile?: string;
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
	/** Makes a change of 1 to 2,000 writes, whole at one position or not at all (D4, D5). */
	change(input: ChangeInput, write: WriteContext): StoreOutcome<ChangeAnswer>;
	read(input: ReadInput): StoreOutcome<ReadAnswer>;
	find(input: FindInput): StoreOutcome<FindAnswer>;
	historyBound(): StoreOutcome<HistoryBoundAnswer>;
	/** Gives the changes after a position the store still holds, one page at a time (EM16). */
	changes(input: ChangesInput): StoreOutcome<ChangesAnswer>;
	/** Follows the entities of a kind carrying a set of tags from a position, one page at a time (EM17). */
	follow(input: FollowInput): StoreOutcome<FollowAnswer>;
	/** Resolves with the store's position once it is above `after` (EM17). */
	waitForChange(after: number, options?: WaitOptions): Promise<number>;
	/** Says whether a write is a recognised repeat, without making it (EM13, step 2). */
	checkRepeat(operation: WriteOperation, input: CreateInput | UpdateInput | DeleteInput, write: WriteContext): RepeatCheck;
	/** Says whether a change is a recognised repeat, without making it (D4, D5). */
	checkRepeat(operation: "change", input: ChangeInput, write: WriteContext): RepeatCheck;
}
