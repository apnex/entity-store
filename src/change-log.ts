/**
 * The change log's records and the state they build (EM15, D33).
 *
 * On recovery every record is checked to hold exactly the fields EM15 names, each of its type, and the
 * changes' positions to run from 1 without a gap; the first record that breaks this stops the store
 * opening, naming its line. The records are then replayed in order, and each change's writes in order: a
 * create or update makes its entity the entity's state, a delete removes the entity and frees its name,
 * each change makes its write identity name it, and every time advances the store's time (EM8).
 */
import type { JsonObject, JsonValue } from "@apnex/shape-check";
import type { ChangeRecord, EntityEnvelope, LoadedRecord, WriteAnswer } from "./store-types.js";

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

/** Milliseconds of an ISO 8601 time as the store writes it, or undefined when it is not one. */
export function parseTime(text: unknown): number | undefined {
	if (typeof text !== "string" || !ISO_TIME.test(text)) return undefined;
	const ms = Date.parse(text);
	return Number.isFinite(ms) && new Date(ms).toISOString() === text ? ms : undefined;
}

/** The state the change log builds: entities with their history, names, write identities, positions and the latest time. */
export class RecoveredState {
	position = 0;
	latestAt = Number.NEGATIVE_INFINITY;
	/** Each entity's versions in order: the position that wrote it and the envelope it left, or null once deleted. */
	readonly history = new Map<string, { position: number; entity: EntityEnvelope | null }[]>();
	/** Per kind, each name held by an entity that is not deleted, and that entity's identity. */
	readonly names = new Map<string, Map<string, string>>();
	readonly writes = new Map<string, RememberedWrite>();
	/** The time of each change, by position; index 0 is unused. */
	readonly changeTimes: number[] = [Number.NaN];

	/** Applies a change: its writes in order, its write identity, its position and its time. */
	apply(record: ChangeRecord, atMs: number): void {
		for (const write of record.writes) {
			const versions = this.history.get(write.id) ?? [];
			const previous = versions[versions.length - 1]?.entity ?? null;
			if (previous !== null) this.names.get(previous.kind)?.delete(previous.name);
			if (write.entity !== null) {
				let kindNames = this.names.get(write.entity.kind);
				if (kindNames === undefined) this.names.set(write.entity.kind, (kindNames = new Map()));
				kindNames.set(write.entity.name, write.id);
			}
			versions.push({ position: record.position, entity: write.entity });
			this.history.set(write.id, versions);
		}
		this.writes.set(record.writeId, { position: record.position, at: atMs, digest: record.digest, answer: record.answer });
		this.position = record.position;
		this.changeTimes[record.position] = atMs;
		this.latestAt = Math.max(this.latestAt, atMs);
	}

	/** The entity a target names now, if it is not deleted. */
	resolve(target: { id?: string; kind?: string; name?: string }): EntityEnvelope | undefined {
		const id = target.id ?? this.names.get(target.kind as string)?.get(target.name as string);
		if (id === undefined) return undefined;
		const versions = this.history.get(id);
		return versions?.[versions.length - 1]?.entity ?? undefined;
	}

	/** The time of the change at a position. */
	changeAt(position: number): number {
		return this.changeTimes[position] as number;
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

/** The fault in one record, or undefined when it holds exactly the fields EM15 names, each of its type. */
function checkRecord(record: unknown, expectedPosition: number): Check {
	if (!isJsonObject(record)) return "the record is not an object";
	if (record.type === "time") {
		return exactFields(record, ["type", "at"], "the time record") ?? (parseTime(record.at) === undefined ? "the time record's at is not a time in UTC to the millisecond" : undefined);
	}
	if (record.type !== "change") return Object.hasOwn(record, "type") ? "the record's type is neither change nor time" : "the record lacks the field type";
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
	if (record.position !== expectedPosition) return `the change's position is ${record.position} where ${expectedPosition} follows without a gap`;
	return undefined;
}

/** Replays the records a storage port loaded, or names the first line that stops the store opening. */
export function recoverLog(records: readonly LoadedRecord[]): { ok: true; state: RecoveredState } | { ok: false; line: number; message: string } {
	const state = new RecoveredState();
	for (const { line, record } of records) {
		const fault = checkRecord(record, state.position + 1);
		if (fault) return { ok: false, line, message: `line ${line}: ${fault}` };
		const checked = record as { type: string; at: string };
		const atMs = parseTime(checked.at) as number;
		if (checked.type === "time") state.latestAt = Math.max(state.latestAt, atMs);
		else state.apply(record as unknown as ChangeRecord, atMs);
	}
	return { ok: true, state };
}
