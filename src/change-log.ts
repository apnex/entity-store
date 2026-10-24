/**
 * The change log's records and the state they build (EM8, EM15, EM16, EM17, D33, D68, D69, BL26).
 *
 * On recovery every record is checked to hold exactly the fields EM15 names, each of its type, with an
 * optional leading `base` record on line 2 and the changes' positions running from 1 (or from
 * `base.position + 1` after a `base` record) without a gap; the first record that breaks this stops the
 * store opening, naming its line. The records are then replayed in order, and each change's writes in order:
 * a `base` record sets the compacted frontier and each live entity's baseline state there, a create or update
 * makes its entity the entity's state, a delete removes the entity and frees its name, each change makes its
 * write identity name it, and every time advances the store's time (EM8).
 */
import type { JsonObject, JsonValue } from "@apnex/shape-check";
import type { BaseRecord, ChangeItem, ChangeRecord, DeletedItem, EntityEnvelope, LoadedRecord, LogRecord, WriteAnswer } from "./store-types.js";

/** True for a JSON object, false for null, arrays and scalars. */
export function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compares two strings by Unicode code point, not by UTF-16 code unit. */
export function compareCodePoints(a: string, b: string): number {
	const x = a[Symbol.iterator]();
	const y = b[Symbol.iterator]();
	for (;;) {
		const p = x.next();
		const q = y.next();
		if (p.done) return q.done ? 0 : -1;
		if (q.done) return 1;
		const d = (p.value.codePointAt(0) ?? 0) - (q.value.codePointAt(0) ?? 0);
		if (d !== 0) return d;
	}
}

/** What the store remembers of the latest change made under a write identity (EM7). */
export interface RememberedWrite {
	position: number;
	at: number;
	digest: string;
	answer: WriteAnswer;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;

/** Milliseconds of an ISO 8601 time as the store writes it, or undefined when it is not one. */
export function parseTime(text: unknown): number | undefined {
	if (typeof text !== "string" || !ISO_TIME.test(text)) return undefined;
	const ms = Date.parse(text);
	return Number.isFinite(ms) && new Date(ms).toISOString() === text ? ms : undefined;
}

/** The state the change log builds: entities with their held history, names, write identities, positions and the latest time. */
export class RecoveredState {
	position = 0;
	latestAt = Number.NEGATIVE_INFINITY;
	/** The greatest position forgotten once outside the history bound by `latestAt` (EM8, EM15, BL26). */
	forgottenThrough = 0;
	/** The timestamp (ms) of the change at `forgottenThrough`. */
	forgottenAt = Number.NEGATIVE_INFINITY;
	/** The 64-character SHA-256 `digest` of the change at `forgottenThrough`. */
	forgottenDigest = "";
	/** How many `time` records sit in the active log since the last compaction. */
	timeRecordCount = 0;
	/** Each entity's versions in order: at most one baseline at or before `forgottenThrough` (if alive there) and held versions after it. */
	readonly history = new Map<string, { position: number; entity: EntityEnvelope | null }[]>();
	/** Per kind, each name held by an entity that is not deleted, and that entity's identity. */
	readonly names = new Map<string, Map<string, string>>();
	readonly writes = new Map<string, RememberedWrite>();
	/** The time of each held change (`> forgottenThrough`), by position. */
	readonly changeTimes = new Map<number, number>();
	/** What `changes` gives of each held change (`> forgottenThrough`), by position (EM16). */
	readonly changeItems = new Map<number, ChangeItem[]>();
	/** Each held change record (`> forgottenThrough`), by position, for compaction (EM15). */
	readonly changeRecords = new Map<number, ChangeRecord>();
	/** Each held change's 64-character digest (`> forgottenThrough`), by position (EM15). */
	readonly changeDigests = new Map<number, string>();
	/** The canonical JSON size of each item of a held change (`> forgottenThrough`), by position, measured once. */
	readonly itemSizes = new Map<number, number[]>();

	/** Applies a leading `base` record at the start of recovery (EM15). */
	applyBase(record: BaseRecord, atMs: number): void {
		this.position = record.position;
		this.forgottenThrough = record.position;
		this.forgottenAt = atMs;
		this.forgottenDigest = record.digest;
		this.latestAt = Math.max(this.latestAt, atMs);
		for (const entity of record.entities) {
			const copy = structuredClone(entity);
			this.history.set(copy.id, [{ position: copy.changed.position, entity: copy }]);
			let kindNames = this.names.get(copy.kind);
			if (kindNames === undefined) this.names.set(copy.kind, (kindNames = new Map()));
			kindNames.set(copy.name, copy.id);
		}
	}

	/** Applies a change: its writes in order, its write identity, its position, its time and its items. */
	apply(record: ChangeRecord, atMs: number): void {
		const items: ChangeItem[] = [];
		for (const write of record.writes) {
			const versions = this.history.get(write.id) ?? [];
			const previous = versions[versions.length - 1]?.entity ?? null;
			if (previous !== null) this.names.get(previous.kind)?.delete(previous.name);
			if (write.entity !== null) {
				let kindNames = this.names.get(write.entity.kind);
				if (kindNames === undefined) this.names.set(write.entity.kind, (kindNames = new Map()));
				kindNames.set(write.entity.name, write.id);
			}
			items.push(write.entity ?? deletedItem(write.id, previous, versions.length, record));
			versions.push({ position: record.position, entity: write.entity });
			this.history.set(write.id, versions);
		}
		this.writes.set(record.writeId, { position: record.position, at: atMs, digest: record.digest, answer: record.answer });
		this.position = record.position;
		this.changeTimes.set(record.position, atMs);
		this.changeItems.set(record.position, items);
		this.changeRecords.set(record.position, structuredClone(record));
		this.changeDigests.set(record.position, record.digest);
		this.latestAt = Math.max(this.latestAt, atMs);
	}

	/**
	 * Forgets every held change `p` whose time is at or before `cutoffMs` (`latestAt - historyMs`), advancing
	 * `forgottenThrough` and evicting every write identity, change record, digest, time, item list, item-size
	 * entry and superseded or deleted entity version at or before `forgottenThrough` (EM8, EM15, EM17, BL26).
	 * Returns true when `forgottenThrough` advanced.
	 */
	forgetBefore(cutoffMs: number): boolean {
		let nextForgotten = this.forgottenThrough;
		for (let p = this.forgottenThrough + 1; p <= this.position; p++) {
			const at = this.changeTimes.get(p);
			if (at === undefined || at > cutoffMs) break;
			nextForgotten = p;
		}
		if (nextForgotten === this.forgottenThrough) return false;
		for (let p = this.forgottenThrough + 1; p <= nextForgotten; p++) {
			this.forgottenAt = this.changeTimes.get(p) as number;
			this.forgottenDigest = this.changeDigests.get(p) as string;
			this.changeTimes.delete(p);
			this.changeItems.delete(p);
			this.changeRecords.delete(p);
			this.changeDigests.delete(p);
			this.itemSizes.delete(p);
		}
		for (const [writeId, remembered] of this.writes) {
			if (remembered.position <= nextForgotten) this.writes.delete(writeId);
		}
		for (const [id, versions] of this.history) {
			let baseline: { position: number; entity: EntityEnvelope | null } | undefined;
			const after: { position: number; entity: EntityEnvelope | null }[] = [];
			for (const version of versions) {
				if (version.position <= nextForgotten) baseline = version;
				else after.push(version);
			}
			if (baseline !== undefined && baseline.entity !== null) {
				this.history.set(id, [baseline, ...after]);
			} else if (after.length > 0) {
				this.history.set(id, after);
			} else {
				this.history.delete(id);
			}
		}
		this.forgottenThrough = nextForgotten;
		return true;
	}

	/** Every entity of any kind alive as of a position, sorted by `(kind, name)` in Unicode code-point order. */
	allEntitiesAsOf(position: number): EntityEnvelope[] {
		const found: EntityEnvelope[] = [];
		for (const versions of this.history.values()) {
			let state: EntityEnvelope | null = null;
			for (const version of versions) {
				if (version.position > position) break;
				state = version.entity;
			}
			if (state !== null) found.push(structuredClone(state));
		}
		return found.sort((a, b) => compareCodePoints(a.kind, b.kind) || compareCodePoints(a.name, b.name));
	}

	/** The compacted active log records for the current state (EM15). */
	compactedRecords(): LogRecord[] {
		const out: LogRecord[] = [];
		let lastRecordAt = Number.NEGATIVE_INFINITY;
		if (this.forgottenThrough >= 1) {
			out.push({
				type: "base",
				position: this.forgottenThrough,
				at: new Date(this.forgottenAt).toISOString(),
				digest: this.forgottenDigest,
				entities: this.allEntitiesAsOf(this.forgottenThrough),
			});
			lastRecordAt = this.forgottenAt;
		}
		for (let p = this.forgottenThrough + 1; p <= this.position; p++) {
			const record = this.changeRecords.get(p) as ChangeRecord;
			out.push(structuredClone(record));
			lastRecordAt = this.changeTimes.get(p) as number;
		}
		if (this.latestAt !== Number.NEGATIVE_INFINITY && (out.length === 0 || this.latestAt > lastRecordAt)) {
			out.push({ type: "time", at: new Date(this.latestAt).toISOString() });
			this.timeRecordCount = 1;
		} else {
			this.timeRecordCount = 0;
		}
		return out;
	}

	/** The entity a target names now, if it is not deleted. */
	resolve(target: { id?: string; kind?: string; name?: string }): EntityEnvelope | undefined {
		const id = target.id ?? this.names.get(target.kind as string)?.get(target.name as string);
		if (id === undefined) return undefined;
		const versions = this.history.get(id);
		return versions?.[versions.length - 1]?.entity ?? undefined;
	}

	/** The time of the held change at a position. */
	changeAt(position: number): number {
		return this.changeTimes.get(position) as number;
	}

	/**
	 * An entity's state before the change at a position and after it (EM17): its latest version written before
	 * that position, and its latest version written at or before it, each null when there is none or it is deleted.
	 */
	aroundChange(id: string, position: number): { before: EntityEnvelope | null; after: EntityEnvelope | null } {
		const versions = this.history.get(id) ?? [];
		let before: EntityEnvelope | null = null;
		let after: EntityEnvelope | null = null;
		for (const version of versions) {
			if (version.position > position) break;
			if (version.position < position) before = version.entity;
			after = version.entity;
		}
		return { before, after };
	}

	/** Every entity of a kind as of a position: each one's latest version at or before it, if not deleted. */
	entitiesAsOf(kind: string, position: number): EntityEnvelope[] {
		const found: EntityEnvelope[] = [];
		for (const versions of this.history.values()) {
			let state: EntityEnvelope | null = null;
			for (const version of versions) {
				if (version.position > position) break;
				state = version.entity;
			}
			if (state !== null && state.kind === kind) found.push(state);
		}
		return found.sort((a, b) => compareCodePoints(a.name, b.name));
	}
}

/**
 * The item a delete leaves (EM16): the entity's identity, kind and name as the delete found them and the
 * revision the delete gave it, taken from the state the delete's write replaced and never from the change's
 * answer, then the change's position, time and writer. A delete of an entity with no state before it is
 * found only in a change log the store did not write (EM15), which is outside what it promises; its item
 * then names an empty kind and name.
 */
function deletedItem(id: string, previous: EntityEnvelope | null, versions: number, record: ChangeRecord): DeletedItem {
	const deleted = previous === null
		? { id, kind: "", name: "", revision: versions + 1 }
		: { id, kind: previous.kind, name: previous.name, revision: previous.revision + 1 };
	return { deleted, position: record.position, at: record.at, writer: record.writer };
}

type Check = string | undefined;

function exactFields(value: Record<string, unknown>, fields: readonly string[], where: string): Check {
	for (const field of fields) if (!Object.hasOwn(value, field)) return `${where} lacks the field ${field}`;
	for (const field of Object.keys(value)) if (!fields.includes(field)) return `${where} holds the field ${field}, which it may not`;
	return undefined;
}

const isPositionNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isString = (v: unknown): v is string => typeof v === "string";

function checkStamp(value: unknown, where: string): Check {
	if (!isJsonObject(value)) return `${where} is not an object`;
	const fields = exactFields(value, ["position", "at", "writer"], where);
	if (fields) return fields;
	if (!isPositionNumber(value.position)) return `${where}.position is not a position`;
	if (parseTime(value.at) === undefined) return `${where}.at is not a time in UTC to the millisecond`;
	if (!isString(value.writer)) return `${where}.writer is not a string`;
	return undefined;
}

function checkEnvelope(value: unknown, where: string): Check {
	if (!isJsonObject(value)) return `${where} is not an object`;
	const fields = exactFields(value, ["id", "kind", "name", "tags", "body", "revision", "created", "changed"], where);
	if (fields) return fields;
	if (!isString(value.id) || !isString(value.kind) || !isString(value.name)) return `${where} has an id, kind or name that is not a string`;
	if (!Array.isArray(value.tags) || !value.tags.every(isString)) return `${where}.tags is not a list of strings`;
	if (!isPositionNumber(value.revision)) return `${where}.revision is not a whole number from 1`;
	return checkStamp(value.created, `${where}.created`) ?? checkStamp(value.changed, `${where}.changed`);
}

// An answer is EM10's: `position` with `entity` for a create or update, or with `deleted` for a delete.
function checkAnswer(value: unknown): Check {
	const where = "the change's answer";
	if (!isJsonObject(value)) return `${where} is not an object`;
	if (Object.hasOwn(value, "deleted")) {
		const fields = exactFields(value, ["position", "deleted"], where);
		if (fields) return fields;
		if (!isPositionNumber(value.position)) return `${where}.position is not a position`;
		const deleted = value.deleted;
		if (!isJsonObject(deleted)) return `${where}.deleted is not an object`;
		const deletedFields = exactFields(deleted, ["id", "kind", "name", "revision"], `${where}.deleted`);
		if (deletedFields) return deletedFields;
		if (!isString(deleted.id) || !isString(deleted.kind) || !isString(deleted.name)) return `${where}.deleted has an id, kind or name that is not a string`;
		return isPositionNumber(deleted.revision) ? undefined : `${where}.deleted.revision is not a whole number from 1`;
	}
	const fields = exactFields(value, ["position", "entity"], where);
	if (fields) return fields;
	if (!isPositionNumber(value.position)) return `${where}.position is not a position`;
	return checkEnvelope(value.entity, `${where}.entity`);
}

/** Checks a `change` record's fields and types without requiring a specific expected position (used by archive validation). */
export function checkChangeRecordShape(record: unknown): Check {
	if (!isJsonObject(record)) return "the record is not an object";
	if (record.type !== "change") return "the record's type is not change";
	const fields = exactFields(record, ["type", "position", "at", "writer", "writeId", "digest", "answer", "writes"], "the change record");
	if (fields) return fields;
	if (!isPositionNumber(record.position)) return "the change's position is not a whole number from 1";
	if (parseTime(record.at) === undefined) return "the change's at is not a time in UTC to the millisecond";
	if (!isString(record.writer)) return "the change's writer is not a string";
	if (!isString(record.writeId)) return "the change's writeId is not a string";
	if (!isString(record.digest)) return "the change's digest is not a string";
	const answer = checkAnswer(record.answer);
	if (answer) return answer;
	if (!Array.isArray(record.writes) || record.writes.length === 0) return "the change's writes is not a list of one or more writes";
	for (const [i, write] of (record.writes as JsonValue[]).entries()) {
		const where = `write ${i + 1}`;
		if (!isJsonObject(write)) return `${where} is not an object`;
		const writeFields = exactFields(write, ["operation", "id", "entity"], where);
		if (writeFields) return writeFields;
		if (write.operation !== "create" && write.operation !== "update" && write.operation !== "delete") return `${where}'s operation is not create, update or delete`;
		if (!isString(write.id)) return `${where}'s id is not a string`;
		if (write.operation === "delete") {
			if (write.entity !== null) return `${where} is a delete whose entity is not null`;
		} else {
			const envelope = checkEnvelope(write.entity, `${where}'s entity`);
			if (envelope) return envelope;
		}
	}
	return undefined;
}

function checkBaseRecord(record: Record<string, unknown>, isFirstRecord: boolean): Check {
	if (!isFirstRecord) return "the base record is not the change log's first record";
	const fields = exactFields(record, ["type", "position", "at", "digest", "entities"], "the base record");
	if (fields) return fields;
	if (!isPositionNumber(record.position)) return "the base record's position is not a whole number from 1";
	if (parseTime(record.at) === undefined) return "the base record's at is not a time in UTC to the millisecond";
	if (!isString(record.digest) || !DIGEST_HEX.test(record.digest)) return "the base record's digest is not 64 lowercase hexadecimal digits";
	if (!Array.isArray(record.entities)) return "the base record's entities is not a list";
	const seenIds = new Set<string>();
	const seenNames = new Set<string>();
	for (const [i, raw] of (record.entities as JsonValue[]).entries()) {
		const where = `base entity ${i + 1}`;
		const env = checkEnvelope(raw, where);
		if (env) return env;
		const entity = raw as unknown as EntityEnvelope;
		if (entity.created.position > entity.changed.position || entity.changed.position > record.position) {
			return `${where} has created.position (${entity.created.position}) or changed.position (${entity.changed.position}) after the base position (${record.position})`;
		}
		if (seenIds.has(entity.id)) return `${where} duplicates the id ${entity.id}`;
		seenIds.add(entity.id);
		const nameKey = `${entity.kind}\0${entity.name}`;
		if (seenNames.has(nameKey)) return `${where} duplicates the name ${entity.name} in kind ${entity.kind}`;
		seenNames.add(nameKey);
	}
	return undefined;
}

/** The fault in one record, or undefined when it holds exactly the fields EM15 names, each of its type. */
function checkRecord(record: unknown, expectedPosition: number, isFirstRecord: boolean): Check {
	if (!isJsonObject(record)) return "the record is not an object";
	if (record.type === "base") return checkBaseRecord(record, isFirstRecord);
	if (record.type === "time") {
		return exactFields(record, ["type", "at"], "the time record") ?? (parseTime(record.at) === undefined ? "the time record's at is not a time in UTC to the millisecond" : undefined);
	}
	if (record.type !== "change") return Object.hasOwn(record, "type") ? "the record's type is neither change nor time" : "the record lacks the field type";
	const shape = checkChangeRecordShape(record);
	if (shape) return shape;
	if (record.position !== expectedPosition) return `the change's position is ${record.position} where ${expectedPosition} follows without a gap`;
	return undefined;
}

/** Replays the records a storage port loaded, or names the first line that stops the store opening. */
export function recoverLog(records: readonly LoadedRecord[]): { ok: true; state: RecoveredState } | { ok: false; line: number; message: string } {
	const state = new RecoveredState();
	for (const [index, { line, record }] of records.entries()) {
		const fault = checkRecord(record, state.position + 1, index === 0);
		if (fault) return { ok: false, line, message: `line ${line}: ${fault}` };
		const checked = record as { type: string; at: string };
		const atMs = parseTime(checked.at) as number;
		if (checked.type === "base") {
			state.applyBase(record as unknown as BaseRecord, atMs);
		} else if (checked.type === "time") {
			state.latestAt = Math.max(state.latestAt, atMs);
			state.timeRecordCount++;
		} else {
			state.apply(record as unknown as ChangeRecord, atMs);
		}
	}
	return { ok: true, state };
}
