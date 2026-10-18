// changes-since-position - every change after a position still held, once and in order, or a plain statement
// that the position is no longer held (zorg's target, EM16, with the writer bound of EM7 and EM9, zorg's D65;
// Delta 4's D4-E1).
//
// Runs the shared suite's cases for this row locally, over memory storage and over a change log file, each
// with its restarts; then the cases only a local store can show: the writer bound, which no remote write can
// reach since the host names the writer; changes recovered from logs the store's operations no longer make -
// a change of several writes, and one whose writer is longer than the bound - each given whole; the time
// records and clock readings of deciding whether a position is held; a failed time append; and inputs that do
// not fit the operation's shape.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { toCanonicalJson } from "@apnex/shape-check";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { createLocalHarness } from "../support/local-harness.js";
import { KINDS, note, openLocal, T0 } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["changes-since-position"]);
registerEntityStoreSuite((name, run) => test(`file port: ${name}`, run), createLocalHarness({ storage: "file" }), ["changes-since-position"]);

const PAGE = 524288;
const iso = (ms) => new Date(ms).toISOString();
const bytes = (value) => Buffer.byteLength(toCanonicalJson(value), "utf8");
const digest = (operation, input, writer) => createHash("sha256").update(toCanonicalJson({ input, operation, writer }), "utf8").digest("hex");
const changeCount = (storage) => storage.records().filter((r) => r.type === "change").length;

/** Opens a store over a storage port that must open. */
function open(storage, { time = T0, clock, historyMs = 60_000 } = {}) {
	const opening = openEntityStore({ storage, clock: clock ?? { now: () => time }, historyMs, maxEntityBytes: 65_536, kinds: KINDS });
	if (!opening.opened) throw new Error(`the store did not open: ${JSON.stringify(opening.refusal)}`);
	return opening.store;
}

/** An envelope of kind note as a fixture writes it into a log. */
function envelope(id, name, position, { revision = 1, created = position, writer = "fixture", summary = `about ${name}` } = {}) {
	const at = iso(T0);
	return {
		id, kind: "note", name, tags: [], body: { pointer: `https://example.com/${name}`, summary }, revision,
		created: { position: created, at, writer }, changed: { position, at, writer },
	};
}

/** A change record as a fixture writes it: its writes in order, with an answer of the store's form. */
function change(position, writes, { writer = "fixture", writeId = `fixture-${position}`, answer } = {}) {
	const first = writes[0];
	const made = answer ?? (first.entity === null
		? { position, deleted: { id: first.id, kind: "note", name: "unknown", revision: 1 } }
		: { position, entity: first.entity });
	return { type: "change", position, at: iso(T0), writer, writeId, digest: "0".repeat(64), answer: made, writes };
}

// The writer bound (EM7, EM9, D65).

let writes = 0;
const write = (writer, writeId = `w-${++writes}`) => ({ writer, writeId });

test("local: a writer of 1024 code points is accepted and one of 1025 refused as writer-too-long, with exactly length and limit, by a create, an update and a delete alike", () => {
	const { store, storage } = openLocal();
	const ok = "a".repeat(1024);
	const long = "a".repeat(1025);
	assert.equal(store.create(note("alpha"), write("")).outcome, "answered", "an empty writer");
	assert.equal(store.create(note("beta"), write(ok)).outcome, "answered", "1024 code points");
	const before = changeCount(storage);
	for (const [operation, run] of [
		["create", (w) => store.create(note("gamma"), w)],
		["update", (w) => store.update({ target: { kind: "note", name: "beta" }, name: "delta" }, w)],
		["delete", (w) => store.delete({ target: { kind: "note", name: "beta" } }, w)],
	]) {
		const outcome = run(write(long));
		assert.equal(outcome.outcome, "refused", `${operation} with 1025 code points`);
		assert.equal(outcome.refusal.code, "writer-too-long", operation);
		assert.equal(outcome.refusal.part, "entity-store");
		assert.deepEqual(outcome.refusal.details, { length: 1025, limit: 1024 }, `${operation}'s details`);
		assert.deepEqual(Object.keys(outcome.refusal).sort(), ["code", "details", "fix", "part", "what", "why"]);
	}
	assert.equal(changeCount(storage), before, "a refused write takes no position");
	assert.equal(store.historyBound().answer.position, 2);
	assert.equal(store.update({ target: { kind: "note", name: "beta" }, name: "delta" }, write(ok)).outcome, "answered", "an update by 1024 code points");
	assert.equal(store.delete({ target: { kind: "note", name: "delta" } }, write(ok)).outcome, "answered", "a delete by 1024 code points");
});

test("local: a writer's length is its code points as a string iterates them - a character outside the Basic Multilingual Plane is one, and a lone surrogate one", () => {
	const { store } = openLocal();
	const cases = [
		["\u{1F600}", "characters of two UTF-16 units"],
		["\ud800", "lone high surrogates"],
		["\udc00", "lone low surrogates"],
		["\u00e9", "characters of two UTF-8 bytes"],
	];
	for (const [i, [unit, what]] of cases.entries()) {
		assert.equal(store.create(note(`ok-${i}`), write(unit.repeat(1024))).outcome, "answered", `1024 ${what}`);
		const refused = store.create(note(`long-${i}`), write(unit.repeat(1025)));
		assert.equal(refused.refusal?.code, "writer-too-long", `1025 ${what}`);
		assert.deepEqual(refused.refusal.details, { length: 1025, limit: 1024 }, `1025 ${what}, counted in code points`);
	}
	const mixed = `${"a".repeat(1022)}\u{1F600}\ud800`;
	assert.equal(mixed.length, 1025, "1025 UTF-16 units");
	assert.equal(store.create(note("mixed"), write(mixed)).outcome, "answered", "1024 code points in 1025 UTF-16 units");
});

test("local: a writer-too-long refusal leaves its write identity unremembered, so the identity's next write runs afresh", () => {
	const { store } = openLocal();
	assert.equal(store.create(note("alpha"), write("a".repeat(1025), "w1")).refusal?.code, "writer-too-long");
	const next = store.create(note("beta"), write("alice", "w1"));
	assert.equal(next.outcome, "answered", "another request under the same identity is not identity-reused");
	assert.equal(next.answer.position, 1);
});

test("local: writer-too-long comes after identity-reused and before every later refusal", () => {
	const { store } = openLocal();
	assert.equal(store.create(note("alpha"), write("alice", "w1")).outcome, "answered");
	const long = "a".repeat(1025);
	assert.equal(store.create(note("beta"), write(long, "w1")).refusal?.code, "identity-reused", "a retained identity with another digest is refused first");
	assert.equal(store.create({ ...note("gamma"), kind: "nothing" }, write(long)).refusal?.code, "writer-too-long", "before unknown-kind");
	assert.equal(store.create({ ...note("alpha") }, write(long)).refusal?.code, "writer-too-long", "before name-taken");
	assert.equal(store.update({ target: { id: "e9.1" }, name: "x" }, write(long)).refusal?.code, "writer-too-long", "before not-found");
	assert.equal(store.create({ ...note("delta"), tags: ["BAD"] }, write(long)).refusal?.code, "writer-too-long", "before invalid-tag");
});

test("local: a repeat of a recovered change whose writer is longer than the bound is still recognised, and answered as first", () => {
	const writer = "w".repeat(2000);
	const input = note("alpha");
	const entity = envelope("e1.1", "alpha", 1, { writer });
	const storage = createMemoryStoragePort();
	storage.append({ ...change(1, [{ operation: "create", id: "e1.1", entity }], { writer, writeId: "legacy" }), digest: digest("create", input, writer) });
	const store = open(storage, { time: T0 + 10 });
	const repeat = store.create(input, { writer, writeId: "legacy" });
	assert.deepEqual(repeat, { outcome: "answered", answer: { position: 1, entity } }, "the first answer");
	assert.equal(changeCount(storage), 1, "no second position");
	assert.equal(store.create(note("beta"), { writer, writeId: "fresh" }).refusal?.code, "writer-too-long", "a new write by that writer is refused");
});

// Changes recovered from logs the store's operations no longer make.

test("local: a change recovered from a log written before the writer bound, larger than a page, is given alone in its page, past the page's size, and not skipped", () => {
	const longWriter = "w".repeat(600_000);
	const storage = createMemoryStoragePort();
	const first = envelope("e1.1", "alpha", 1);
	const third = envelope("e3.1", "gamma", 3);
	storage.append(change(1, [{ operation: "create", id: "e1.1", entity: first }]));
	storage.append(change(2, [{ operation: "delete", id: "e1.1", entity: null }], { writer: longWriter, answer: { position: 2, deleted: { id: "e1.1", kind: "note", name: "alpha", revision: 2 } } }));
	storage.append(change(3, [{ operation: "create", id: "e3.1", entity: third }]));
	const store = open(storage);
	const one = store.changes({ since: 0 }).answer;
	assert.deepEqual(one, { position: 3, changes: [first], next: 1 }, "the first page stops before the large change");
	const two = store.changes({ since: 1 }).answer;
	assert.deepEqual(two, { position: 3, changes: [{ deleted: { id: "e1.1", kind: "note", name: "alpha", revision: 2 }, position: 2, at: iso(T0), writer: longWriter }], next: 2 }, "the large change alone");
	assert.ok(bytes(two.changes) > PAGE, "its page is past the page's size");
	assert.deepEqual(store.changes({ since: 2 }).answer, { position: 3, changes: [third], next: null }, "and the change after it follows");
});

/**
 * Writes the records of changes of several writes: the last out of identity order, holding an update and two
 * deletes of entities written earlier, one of them renamed since its create, and answering as the update, so
 * each delete's item can only come from the state its write replaced.
 */
function severalWrites(port) {
	const big = (id, name, position, opts) => envelope(id, name, position, { ...opts, summary: "s".repeat(200_000) });
	const alpha = envelope("e1.1", "alpha", 1);
	const beta = envelope("e1.2", "beta", 1);
	const first = big("e2.1", "first", 2);
	const omega = envelope("e1.1", "omega", 2, { revision: 2, created: 1 });
	const gamma = big("e1.2", "gamma", 3, { revision: 2, created: 1 });
	const delta = big("e3.4", "delta", 3);
	port.append(change(1, [{ operation: "create", id: "e1.1", entity: alpha }, { operation: "create", id: "e1.2", entity: beta }]));
	port.append(change(2, [{ operation: "create", id: "e2.1", entity: first }, { operation: "update", id: "e1.1", entity: omega }]));
	port.append(change(3, [
		{ operation: "update", id: "e1.2", entity: gamma },
		{ operation: "delete", id: "e2.1", entity: null },
		{ operation: "delete", id: "e1.1", entity: null },
		{ operation: "create", id: "e3.4", entity: delta },
	], { answer: { position: 3, entity: gamma } }));
	const deleted = (id, name, revision) => ({ deleted: { id, kind: "note", name, revision }, position: 3, at: iso(T0), writer: "fixture" });
	return { firstPage: [alpha, beta, first, omega], second: [first, omega], third: [gamma, deleted("e2.1", "first", 2), deleted("e1.1", "omega", 3), delta] };
}

function checkSeveralWrites(store, { firstPage, second, third }) {
	assert.deepEqual(store.changes({ since: 0 }).answer, { position: 3, changes: firstPage, next: 2 }, "the first page: changes 1 and 2, each whole and in the order of its writes; change 3 would pass the page");
	assert.deepEqual(store.changes({ since: 2 }).answer, { position: 3, changes: third, next: null }, "change 3 whole, in the order of its writes, out of identity order, each delete named as its write found it");
	assert.ok(bytes([...firstPage, third[0]]) <= PAGE, "change 3's first write alone would have fitted in the first page");
	assert.ok(bytes([...firstPage, ...third]) > PAGE, "change 3 whole would not, so it was not split");
	assert.deepEqual(store.changes({ since: 1 }).answer.changes, second, "since 1, change 2 alone");
}

test("local, memory port: recovered changes of several writes are given whole and in the order of their writes, never split between pages, a delete named as its write found the entity", () => {
	const storage = createMemoryStoragePort();
	const expected = severalWrites(storage);
	checkSeveralWrites(open(storage), expected);
});

test("local, file port: recovered changes of several writes are given whole and in the order of their writes, never split between pages, a delete named as its write found the entity", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-changes-"));
	try {
		const file = path.join(dir, "changes.log");
		const writing = createFileStoragePort(file);
		writing.load();
		const expected = severalWrites(writing);
		writing.close();
		const reading = createFileStoragePort(file);
		try {
			checkSeveralWrites(open(reading), expected);
		} finally {
			reading.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Deciding whether a position is held (EM8, EM16).

const times = (storage) => storage.records().filter((r) => r.type === "time");

test("local: deciding whether a position below the store's is held appends a time record when the store's time is later than the log's; since the store's own position appends none", () => {
	const { store, storage, clock } = openLocal({ historyMs: 1000 });
	store.create(note("alpha"), write("a", "1"));
	clock.set(T0 + 50);
	assert.deepEqual(store.changes({ since: 1 }).answer, { position: 1, changes: [], next: null });
	assert.deepEqual(times(storage), [], "since the store's own position decides nothing about retention");
	store.changes({ since: 0 });
	assert.deepEqual(times(storage), [{ type: "time", at: iso(T0 + 50) }], "since 0 appends the store's time first");
	store.changes({ since: 0 });
	assert.equal(times(storage).length, 1, "at the same time, nothing more is appended");
	clock.set(T0 + 10);
	store.changes({ since: 0 });
	assert.equal(times(storage).length, 1, "with the clock set back the store's time is the log's, and nothing is appended");
});

test("local: since the store's own position reads no clock; a position below it reads the clock, which must be finite and within EM8's range", () => {
	let now = T0;
	let reads = 0;
	const clock = { now: () => { reads++; return now; } };
	const storage = createMemoryStoragePort();
	const store = open(storage, { clock });
	store.create(note("alpha"), write("a"));
	reads = 0;
	store.changes({ since: 1 });
	assert.equal(reads, 0, "since the store's own position reads no clock");
	store.changes({ since: 0 });
	assert.equal(reads, 1, "since 0 reads the clock once");
	now = Number.NaN;
	assert.throws(() => store.changes({ since: 0 }), TypeError, "a clock that is not finite");
	now = 253402300800000;
	assert.throws(() => store.changes({ since: 0 }), RangeError, "a clock past 9999-12-31T23:59:59.999Z");
	assert.equal(store.changes({ since: 1 }).outcome, "answered", "since the store's own position, whatever the clock");
	assert.equal(store.changes({ since: 5 }).refusal?.code, "invalid-position", "a position above the store's is refused without reading the clock");
});

test("local: a failed time append stops the store, which then throws store-stopped for every call", () => {
	const memory = createMemoryStoragePort();
	let failing = false;
	const storage = { load: () => memory.load(), append: (record) => { if (failing) throw new Error("disk full"); memory.append(record); } };
	let now = T0;
	const store = open(storage, { clock: { now: () => now } });
	store.create(note("alpha"), write("a"));
	now = T0 + 100;
	failing = true;
	const stopped = (e) => e?.code === "store-stopped" && e.cause?.message === "disk full";
	assert.throws(() => store.changes({ since: 0 }), stopped, "the time append fails, and the store stops");
	assert.throws(() => store.changes({ since: 1 }), stopped, "since its own position, after it stopped");
	assert.throws(() => store.read({ target: { id: "e1.1" } }), stopped, "a read, after it stopped");
});

// Inputs (EM10, EM16).

test("local: an input that does not fit the shape of changes is a programming error, thrown before any other check, with no clock read and nothing appended", () => {
	let reads = 0;
	const storage = createMemoryStoragePort();
	const store = open(storage, { clock: { now: () => { reads++; return T0; } } });
	store.create(note("alpha"), write("a"));
	const records = storage.records().length;
	reads = 0;
	const naming = (field) => (e) => e instanceof TypeError && e.message.includes(field);
	assert.throws(() => store.changes({}), naming("/since"), "no since, the field named");
	assert.throws(() => store.changes({ since: 0.5 }), naming("/since"), "a fractional since");
	assert.throws(() => store.changes({ since: null }), naming("/since"), "a null since");
	assert.throws(() => store.changes({ since: "0" }), naming("/since"), "a since that is a string");
	assert.throws(() => store.changes({ since: 0, asOf: 0 }), naming("/asOf"), "another field, named");
	for (const input of [5, null, [], "since", true]) assert.throws(() => store.changes(input), TypeError, `the input ${JSON.stringify(input)}`);
	assert.throws(() => store.changes(undefined), TypeError, "no input");
	assert.equal(reads, 0, "no clock read");
	assert.equal(storage.records().length, records, "nothing appended");
});

test("local: the items given are copies, so changing an answer changes nothing the store holds", () => {
	const { store } = openLocal();
	store.create(note("alpha"), write("a"));
	const first = store.changes({ since: 0 }).answer;
	first.changes[0].name = "changed";
	first.changes[0].created.writer = "changed";
	assert.equal(store.changes({ since: 0 }).answer.changes[0].name, "alpha");
	assert.equal(store.changes({ since: 0 }).answer.changes[0].created.writer, "a");
});
