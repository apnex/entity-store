// follow-narrowed-set - changes since a position, narrowed by kind and tags, reporting each entity as entering,
// changing within, or leaving the set; a reader may wait for the next change (zorg's target, EM17, with EM8's
// bound and EM9's refusals; Delta 4's D4-E5).
//
// Runs the shared suite's cases for this row locally, over memory storage and over a change log file, each with
// its restarts; then the cases only a local store can show: the exact pages, cut at 524288 bytes of items with
// characters of several UTF-8 bytes and JSON escapes in them; changes recovered from logs the store's operations
// no longer make - a change of several writes, one writing an entity twice, and one whose writer is longer than
// the bound; 33 distinct tags, beyond the shape entity-api serves `follow` under; the time records and clock
// readings of deciding whether a position is held; inputs that do not fit the operation's shape; and
// `waitForChange`, which no remote operation serves.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { toCanonicalJson } from "@apnex/shape-check";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { createLocalHarness } from "../support/local-harness.js";
import { KINDS, note, openLocal, T0 } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["follow-narrowed-set"]);
registerEntityStoreSuite((name, run) => test(`file port: ${name}`, run), createLocalHarness({ storage: "file" }), ["follow-narrowed-set"]);

const PAGE = 524288;
const iso = (ms) => new Date(ms).toISOString();
const bytes = (value) => Buffer.byteLength(toCanonicalJson(value), "utf8");
let writes = 0;
const write = (writer, writeId = `w-${++writes}`) => ({ writer, writeId });
const turns = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

// The garbage collector, so a test can see that nothing the store holds keeps a settled wait's signal alive.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

/** True once the object a weak reference names has been collected, the collector run between turns. */
async function collected(weak) {
	for (let i = 0; i < 30; i++) {
		await turns(2);
		gc();
		if (weak.deref() === undefined) return true;
	}
	return false;
}

/** A signal of plain methods, which fires its listeners when `fire` is called, holding nothing else. */
function plainSignal({ fireOnAdd = false } = {}) {
	const listeners = new Set();
	const signal = {
		aborted: false,
		reason: undefined,
		addEventListener(_type, listener) {
			listeners.add(listener);
			if (fireOnAdd) signal.fire(new Error("fired as its listener was added"));
		},
		removeEventListener(_type, listener) { listeners.delete(listener); },
		fire(reason) {
			signal.aborted = true;
			signal.reason = reason;
			for (const listener of [...listeners]) listener();
		},
	};
	return signal;
}

/** Opens a store over a storage port that must open. */
function open(storage, { time = T0, clock, historyMs = 60_000, maxEntityBytes = 65_536 } = {}) {
	const opening = openEntityStore({ storage, clock: clock ?? { now: () => time }, historyMs, maxEntityBytes, kinds: KINDS });
	if (!opening.opened) throw new Error(`the store did not open: ${JSON.stringify(opening.refusal)}`);
	return opening.store;
}

/** An envelope of kind note as a fixture writes it into a log. */
function envelope(id, name, position, { revision = 1, created = position, writer = "fixture", tags = [], summary = `about ${name}` } = {}) {
	const at = iso(T0);
	return {
		id, kind: "note", name, tags, body: { pointer: `https://example.com/${name}`, summary }, revision,
		created: { position: created, at, writer: created === position ? writer : "fixture" }, changed: { position, at, writer },
	};
}

/** A change record as a fixture writes it: its writes in order, with an answer of the store's form. */
function change(position, writes, { writer = "fixture", answer } = {}) {
	const first = writes[0];
	const made = answer ?? (first.entity === null
		? { position, deleted: { id: first.id, kind: "note", name: "unknown", revision: 1 } }
		: { position, entity: first.entity });
	return { type: "change", position, at: iso(T0), writer, writeId: `fixture-${position}`, digest: "0".repeat(64), answer: made, writes };
}

/** A follow item, as the store gives it. */
const item = (event, position, id, entity, { at = iso(T0), writer = "fixture" } = {}) => ({ event, position, at, writer, id, entity });

/** Every page of a follow from `since`, until `through` reaches the page's position. */
function pages(store, input) {
	const all = [];
	let since = input.since;
	for (;;) {
		const page = store.follow({ ...input, since }).answer;
		all.push(page);
		if (page.through === page.position) return all;
		since = page.through;
	}
}

// Pages (EM17).

/** A string beginning with characters of two, three and four UTF-8 bytes and characters JSON escapes. */
const PAD_PREFIX = "\u00e9\u20ac\u{1F600}\n\"\\\u0001";
const pad = (n) => PAD_PREFIX + "x".repeat(n);

/**
 * Three entities entering the set of `set:yes`, with a change outside the set between the second and the third,
 * the third sized so the three items are exactly `total` bytes in `changes`.
 */
function exactPages(total) {
	const { store } = openLocal({ maxEntityBytes: 262_144 });
	const items = [];
	for (const name of ["aa", "bb"]) {
		const made = store.create({ kind: "any", name, tags: ["set:yes"], body: { pad: pad(200_000) } }, write("alice")).answer.entity;
		items.push(item("entering", made.created.position, made.id, made, { writer: "alice" }));
	}
	store.create({ kind: "any", name: "out", tags: ["set:no"], body: { pad: pad(100) } }, write("alice"));
	// The third's envelope as the store will write it, its pad sized to make the page exactly `total`.
	const stamp = { position: 4, at: iso(T0), writer: "alice" };
	const probe = { id: "e4.1", kind: "any", name: "cc", tags: ["set:yes"], body: { pad: pad(0) }, revision: 1, created: stamp, changed: { ...stamp } };
	const probeItem = item("entering", 4, "e4.1", probe, { writer: "alice" });
	const fill = total - bytes([...items, probeItem]);
	const made = store.create({ kind: "any", name: "cc", tags: ["set:yes"], body: { pad: pad(fill) } }, write("alice")).answer.entity;
	items.push(item("entering", 4, made.id, made, { writer: "alice" }));
	assert.equal(bytes(items), total, `the three items are ${total} bytes`);
	return { store, items };
}

test("local: a page of exactly 524288 bytes of items holds them all, a change outside the set among them never stopping it; one byte more stops it before the change that would pass it, which the next page, asked from through, begins with", () => {
	const exact = exactPages(PAGE);
	assert.deepEqual(exact.store.follow({ kind: "any", tags: ["set:yes"], since: 0 }).answer, { position: 4, through: 4, changes: exact.items }, "exactly 524288 bytes, in one page");
	const over = exactPages(PAGE + 1);
	const first = over.store.follow({ kind: "any", tags: ["set:yes"], since: 0 }).answer;
	assert.deepEqual(first, { position: 4, through: 3, changes: over.items.slice(0, 2) }, "one byte more: the page takes the change outside the set and stops before the third");
	assert.deepEqual(over.store.follow({ kind: "any", tags: ["set:yes"], since: 3 }).answer, { position: 4, through: 4, changes: over.items.slice(2) }, "the next page, from through, begins with it");
});

test("local: 33 distinct tags match nothing, and through still reaches the store's position", () => {
	const { store } = openLocal();
	const many = Array.from({ length: 32 }, (_, i) => `k${i}:v`);
	store.create(note("full", many), write("alice"));
	assert.equal(store.follow({ kind: "note", tags: many, since: 0 }).answer.changes.length, 1, "the set of 32");
	assert.deepEqual(store.follow({ kind: "note", tags: [...many, "k32:v"], since: 0 }).answer, { position: 1, through: 1, changes: [] }, "33 distinct tags, nothing");
});

// Changes recovered from logs (EM6, EM15, EM17).

/**
 * Writes changes of several writes: three notes in the set; then a change updating one within the set and
 * deleting the other two, in that order; then a change writing the remaining note twice, out of the set and back.
 */
function severalWrites(port) {
	const yes = ["set:yes"];
	const alpha = envelope("e1.1", "alpha", 1, { tags: yes });
	const beta = envelope("e1.2", "beta", 1, { tags: yes });
	const gamma = envelope("e1.3", "gamma", 1, { tags: yes });
	const gamma2 = envelope("e1.3", "gamma", 2, { revision: 2, created: 1, tags: yes, summary: "changed" });
	const gammaOut = envelope("e1.3", "gamma", 3, { revision: 3, created: 1, tags: [] });
	const gammaBack = envelope("e1.3", "gamma", 3, { revision: 4, created: 1, tags: ["set:yes", "topic:z"] });
	port.append(change(1, [{ operation: "create", id: "e1.1", entity: alpha }, { operation: "create", id: "e1.2", entity: beta }, { operation: "create", id: "e1.3", entity: gamma }]));
	port.append(change(2, [{ operation: "update", id: "e1.3", entity: gamma2 }, { operation: "delete", id: "e1.2", entity: null }, { operation: "delete", id: "e1.1", entity: null }], { answer: { position: 2, entity: gamma2 } }));
	port.append(change(3, [{ operation: "update", id: "e1.3", entity: gammaOut }, { operation: "update", id: "e1.3", entity: gammaBack }], { answer: { position: 3, entity: gammaBack } }));
	return [
		item("entering", 1, "e1.1", alpha), item("entering", 1, "e1.2", beta), item("entering", 1, "e1.3", gamma),
		item("changing", 2, "e1.3", gamma2), item("leaving", 2, "e1.2", null), item("leaving", 2, "e1.1", null),
		item("changing", 3, "e1.3", gammaBack), item("changing", 3, "e1.3", gammaBack),
	];
}

test("local, memory port: recovered changes of several writes give an item per write in their order; a change writing an entity twice gives two items alike, each from the state before the change and after it", () => {
	const storage = createMemoryStoragePort();
	const expected = severalWrites(storage);
	assert.deepEqual(open(storage).follow({ kind: "note", tags: ["set:yes"], since: 0 }).answer, { position: 3, through: 3, changes: expected });
});

test("local, file port: recovered changes of several writes give an item per write in their order; a change writing an entity twice gives two items alike", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-follow-"));
	try {
		const file = path.join(dir, "changes.log");
		const writing = createFileStoragePort(file);
		writing.load();
		const expected = severalWrites(writing);
		writing.close();
		const reading = createFileStoragePort(file);
		try {
			assert.deepEqual(open(reading).follow({ kind: "note", tags: ["set:yes"], since: 0 }).answer, { position: 3, through: 3, changes: expected });
		} finally {
			reading.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("local: a recovered change of several writes whose first item alone would fit beside the page's items, and whose items together would not, is not split: the page stops before it, and the next takes it whole", () => {
	const storage = createMemoryStoragePort();
	const yes = ["set:yes"];
	const big = (id, name, position, summary) => envelope(id, name, position, { tags: yes, summary: "s".repeat(summary) });
	const first = big("e1.1", "first", 1, 300_000);
	const left = big("e2.1", "left", 2, 150_000);
	const right = big("e2.2", "right", 2, 150_000);
	storage.append(change(1, [{ operation: "create", id: "e1.1", entity: first }]));
	storage.append(change(2, [{ operation: "create", id: "e2.1", entity: left }, { operation: "create", id: "e2.2", entity: right }]));
	const store = open(storage);
	const one = item("entering", 1, "e1.1", first);
	const two = [item("entering", 2, "e2.1", left), item("entering", 2, "e2.2", right)];
	assert.ok(bytes([one, two[0]]) <= PAGE && bytes([one, ...two]) > PAGE, "its first item alone fits beside the page's, both together do not");
	assert.deepEqual(store.follow({ kind: "note", tags: yes, since: 0 }).answer, { position: 2, through: 1, changes: [one] }, "the page stops before change 2");
	assert.deepEqual(store.follow({ kind: "note", tags: yes, since: 1 }).answer, { position: 2, through: 2, changes: two }, "and the next takes it whole");
});

test("local: a change recovered from a log written before the writer bound, larger than a page, is given alone in its page, past the page's size, and not skipped", () => {
	const longWriter = "w".repeat(600_000);
	const storage = createMemoryStoragePort();
	const yes = ["set:yes"];
	const alpha = envelope("e1.1", "alpha", 1, { tags: yes });
	const alpha2 = envelope("e1.1", "alpha", 2, { revision: 2, created: 1, tags: yes, writer: longWriter });
	const gamma = envelope("e3.1", "gamma", 3, { tags: yes });
	storage.append(change(1, [{ operation: "create", id: "e1.1", entity: alpha }]));
	storage.append(change(2, [{ operation: "update", id: "e1.1", entity: alpha2 }], { writer: longWriter }));
	storage.append(change(3, [{ operation: "create", id: "e3.1", entity: gamma }]));
	const store = open(storage);
	const all = pages(store, { kind: "note", tags: yes, since: 0 });
	assert.deepEqual(all.map((p) => [p.through, p.changes.length]), [[1, 1], [2, 1], [3, 1]], "three pages, the large change alone in the second");
	assert.deepEqual(all[1].changes, [item("changing", 2, "e1.1", alpha2, { writer: longWriter })]);
	assert.ok(bytes(all[1].changes) > PAGE, "its page is past the page's size");
});

test("local: a change whose state before was written before the history bound began is decided while the change itself is within it", () => {
	const { store, clock } = openLocal({ historyMs: 1000 });
	const made = store.create(note("alpha", ["set:yes"]), write("alice")).answer.entity;
	clock.set(T0 + 5000);
	const updated = store.update({ target: { id: made.id }, body: { summary: "later" } }, write("alice")).answer.entity;
	clock.set(T0 + 5500);
	assert.equal(store.follow({ kind: "note", since: 0 }).refusal?.code, "position-not-held", "since 0 is behind the bound");
	assert.deepEqual(store.follow({ kind: "note", tags: ["set:yes"], since: 1 }).answer.changes, [item("changing", 2, made.id, updated, { at: iso(T0 + 5000), writer: "alice" })], "changing, from a state written outside the bound");
});

// Deciding whether a position is held (EM8, EM17).

const times = (storage) => storage.records().filter((r) => r.type === "time");

test("local: deciding whether a position below the store's is held appends a time record, answered and refused alike; since the store's own position, an unknown kind and an invalid position read no clock and append none", () => {
	let now = T0;
	let reads = 0;
	const storage = createMemoryStoragePort();
	const store = open(storage, { clock: { now: () => { reads++; return now; } }, historyMs: 1000 });
	store.create(note("alpha", ["set:yes"]), write("alice"));
	now = T0 + 50;
	reads = 0;
	assert.deepEqual(store.follow({ kind: "note", since: 1 }).answer, { position: 1, through: 1, changes: [] });
	assert.equal(store.follow({ kind: "nothing", since: 0 }).refusal?.code, "unknown-kind");
	assert.equal(store.follow({ kind: "note", since: 5 }).refusal?.code, "invalid-position");
	assert.equal(store.follow({ kind: "note", since: -1 }).refusal?.code, "invalid-position");
	assert.deepEqual([reads, times(storage)], [0, []], "none of these reads the clock or appends a time");
	assert.equal(store.follow({ kind: "note", since: 0 }).answer.changes.length, 1, "since 0, answered");
	assert.deepEqual([reads, times(storage)], [1, [{ type: "time", at: iso(T0 + 50) }]], "it read the clock once and appended the store's time first");
	now = T0 + 1000;
	assert.equal(store.follow({ kind: "note", since: 0 }).refusal?.code, "position-not-held", "refused at the bound");
	assert.deepEqual(times(storage).at(-1), { type: "time", at: iso(T0 + 1000) }, "a refused decision appends its time too");
	now = Number.NaN;
	assert.throws(() => store.follow({ kind: "note", since: 0 }), TypeError, "a clock that is not finite");
	now = 253402300800000;
	assert.throws(() => store.follow({ kind: "note", since: 0 }), RangeError, "a clock past 9999-12-31T23:59:59.999Z");
	assert.equal(store.follow({ kind: "note", since: 1 }).outcome, "answered", "since the store's own position, whatever the clock");
});

test("local: a failed time append for a follow stops the store, rejecting every wait with store-stopped, and every later call throws it", async () => {
	const memory = createMemoryStoragePort();
	let failing = false;
	const storage = { load: () => memory.load(), append: (record) => { if (failing) throw new Error("disk full"); memory.append(record); } };
	let now = T0;
	const store = open(storage, { clock: { now: () => now } });
	store.create(note("alpha"), write("alice"));
	const waiting = store.waitForChange(1);
	now = T0 + 100;
	failing = true;
	const stopped = (e) => e?.code === "store-stopped" && e.cause?.message === "disk full";
	assert.throws(() => store.follow({ kind: "note", since: 0 }), stopped, "the time append fails, and the store stops");
	await assert.rejects(waiting, stopped, "the wait rejects with store-stopped");
	assert.throws(() => store.follow({ kind: "note", since: 1 }), stopped, "a follow, after it stopped");
	assert.throws(() => store.follow({}), stopped, "a malformed follow throws store-stopped first");
	assert.throws(() => store.waitForChange(-1), stopped, "a wait with a malformed after throws store-stopped first");
});

// Inputs (EM17).

test("local: an input that does not fit the shape of follow is a programming error, thrown before any other check, with no clock read and nothing appended", () => {
	let reads = 0;
	const storage = createMemoryStoragePort();
	const store = open(storage, { clock: { now: () => { reads++; return T0; } } });
	store.create(note("alpha"), write("alice"));
	const records = storage.records().length;
	reads = 0;
	const naming = (field) => (e) => e instanceof TypeError && e.message.includes(field);
	assert.throws(() => store.follow({ since: 0 }), naming("/kind"), "no kind, the field named");
	assert.throws(() => store.follow({ kind: "note" }), naming("/since"), "no since, the field named");
	assert.throws(() => store.follow({ kind: "nothing", since: 0.5 }), naming("/since"), "a fractional since, before the unknown kind");
	assert.throws(() => store.follow({ kind: "note", since: null }), naming("/since"), "a null since");
	assert.throws(() => store.follow({ kind: "note", since: "0" }), naming("/since"), "a since that is a string");
	assert.throws(() => store.follow({ kind: "note", since: 0, tags: "set:yes" }), naming("/tags"), "tags that are not a list");
	assert.throws(() => store.follow({ kind: "note", since: 0, tags: [1] }), naming("/tags"), "tags that are not strings");
	assert.throws(() => store.follow({ kind: "note", since: 0, asOf: 0 }), naming("/asOf"), "another field, named");
	for (const input of [5, null, [], "follow", true]) assert.throws(() => store.follow(input), TypeError, `the input ${JSON.stringify(input)}`);
	assert.throws(() => store.follow(undefined), TypeError, "no input");
	assert.equal(reads, 0, "no clock read");
	assert.equal(storage.records().length, records, "nothing appended");
});

test("local: the items given are copies, so changing an answer changes nothing the store holds", () => {
	const { store } = openLocal();
	store.create(note("alpha", ["set:yes"]), write("alice"));
	const first = store.follow({ kind: "note", since: 0 }).answer;
	first.changes[0].entity.name = "changed";
	first.changes[0].entity.tags.push("x:y");
	assert.equal(store.follow({ kind: "note", since: 0 }).answer.changes[0].entity.name, "alpha");
	assert.deepEqual(store.read({ target: { id: "e1.1" } }).answer.entity.tags, ["set:yes"]);
});

// waitForChange (EM17).

test("local: waitForChange resolves at once for an after below the position, and otherwise with the new position on the change passing it; waits of several thresholds, one above the position, each resolve on the change passing it", async () => {
	const { store } = openLocal();
	store.create(note("alpha"), write("alice"));
	assert.equal(await store.waitForChange(0), 1, "at once, with the position");
	const results = {};
	const watch = (name, promise) => promise.then((v) => { results[name] = v; });
	watch("after1", store.waitForChange(1));
	watch("after1-again", store.waitForChange(1));
	watch("after2", store.waitForChange(2));
	watch("after5", store.waitForChange(5));
	await turns();
	assert.deepEqual(results, {}, "none resolves before a change");
	store.create(note("beta"), write("alice"));
	await turns();
	assert.deepEqual(results, { after1: 2, "after1-again": 2 }, "the change at 2 resolves the two waits after 1, and not those after 2 and 5");
	store.create(note("gamma"), write("alice"));
	await turns();
	assert.deepEqual(results, { after1: 2, "after1-again": 2, after2: 3 }, "the change at 3 resolves the wait after 2");
	for (const name of ["d", "e", "f"]) store.create(note(name), write("alice"));
	await turns();
	assert.equal(results.after5, 6, "the wait after 5, above the position when asked, resolves on the change at 6");
});

test("local: a refused write, a recognised repeat and a time record resolve no wait", async () => {
	const { store, storage, clock } = openLocal({ historyMs: 1000 });
	store.create(note("alpha"), write("alice", "the-write"));
	let settled = false;
	const waiting = store.waitForChange(1).then((v) => { settled = true; return v; });
	assert.equal(store.create(note("alpha"), write("alice")).outcome, "refused", "name-taken");
	assert.equal(store.create(note("alpha"), write("alice", "the-write")).outcome, "answered", "the repeat, recognised");
	clock.set(T0 + 50);
	store.follow({ kind: "note", since: 0 });
	assert.equal(storage.records().filter((r) => r.type === "time").length, 1, "a time record appended");
	await turns();
	assert.equal(settled, false, "the wait still waits");
	store.create(note("beta"), write("alice"));
	assert.equal(await waiting, 2);
});

test("local: a wait is settled by the time the write passing it returns, so an abort straight after changes nothing; a wait rejects with its signal's reason when it fires, and at once when it has, the signal checked before the position", async () => {
	const { store } = openLocal();
	const controller = new AbortController();
	const waiting = store.waitForChange(0, { signal: controller.signal });
	store.create(note("alpha"), write("alice"));
	controller.abort(new Error("too late"));
	assert.equal(await waiting, 1, "settled with the change's position as the write returned");
	const second = new AbortController();
	const pending = store.waitForChange(1, { signal: second.signal });
	const reason = new Error("stop waiting");
	second.abort(reason);
	await assert.rejects(pending, (e) => e === reason, "rejected with the signal's reason");
	await assert.rejects(store.waitForChange(0, { signal: second.signal }), (e) => e === reason, "a signal already fired rejects at once, though the position is above after");
});

test("local: waitForChange's arguments - after from 0 to 9007199254740991, options omitted, undefined or an object, its signal an abort signal - and a TypeError for any other", async () => {
	const { store } = openLocal();
	store.create(note("alpha"), write("alice"));
	assert.equal(await store.waitForChange(0, undefined), 1, "options undefined");
	assert.equal(await store.waitForChange(0, {}), 1, "options without a signal");
	assert.equal(await store.waitForChange(0, { signal: undefined }), 1, "a signal undefined");
	const largest = store.waitForChange(9007199254740991);
	assert.ok(largest instanceof Promise, "an after of 9007199254740991 accepted, and waiting");
	for (const after of [-1, 0.5, 9007199254740992, Number.NaN, "0", null, undefined]) assert.throws(() => store.waitForChange(after), TypeError, `after ${String(after)}`);
	for (const options of [null, [], 5, "signal", true]) assert.throws(() => store.waitForChange(0, options), TypeError, `options ${JSON.stringify(options)}`);
	const noListeners = { aborted: false };
	const stringAborted = { aborted: "false", addEventListener() {}, removeEventListener() {} };
	const noRemove = { aborted: false, addEventListener() {} };
	for (const [what, signal] of [["without a boolean aborted", stringAborted], ["without listener methods", noListeners], ["without removeEventListener", noRemove], ["null", null], ["a number", 1]]) {
		assert.throws(() => store.waitForChange(0, { signal }), TypeError, `a signal ${what}`);
	}
	let threw = false;
	const throwing = { aborted: false, addEventListener() { throw new Error("cannot listen"); }, removeEventListener() {} };
	try {
		store.waitForChange(5, { signal: throwing });
	} catch (error) {
		threw = error.message === "cannot listen";
	}
	assert.ok(threw, "a throw from adding the listener is thrown");
});

test("local: waitForChange reads its signal once; a throw from adding its listener is thrown at once, with no wait held; and its arguments are checked before a signal already fired or a position already passed settles it", async () => {
	const { store } = openLocal();
	store.create(note("alpha"), write("alice"));
	let reads = 0;
	const controller = new AbortController();
	const options = { get signal() { reads++; return controller.signal; } };
	const waiting = store.waitForChange(1, options);
	assert.equal(reads, 1, "the signal read once");
	store.create(note("beta"), write("alice"));
	assert.equal(await waiting, 2);
	assert.equal(reads, 1, "and never again");
	const sentinel = new Error("cannot listen");
	let removed = 0;
	const throwing = { aborted: false, addEventListener() { throw sentinel; }, removeEventListener() { removed++; } };
	assert.throws(() => store.waitForChange(5, { signal: throwing }), (e) => e === sentinel, "the throw, synchronously");
	store.create(note("gamma"), write("alice"));
	for (let i = 0; i < 4; i++) store.create(note(`n${i}`), write("alice"));
	await turns();
	assert.equal(removed, 0, "no wait was held, so no change settled one");
	const fired = new AbortController();
	fired.abort(new Error("already"));
	assert.throws(() => store.waitForChange(-1, { signal: fired.signal }), TypeError, "a malformed after before a signal already fired");
	assert.throws(() => store.waitForChange(0.5), TypeError, "a malformed after before a position already passed");
	assert.throws(() => store.waitForChange(0, { signal: { aborted: true } }), TypeError, "a malformed signal, though its aborted is true");
});

test("local: a wait once settled holds no listener; the store holds a wait only while it waits", async () => {
	const { store } = openLocal();
	let listeners = 0;
	const signal = {
		aborted: false,
		addEventListener() { listeners++; },
		removeEventListener() { listeners--; },
	};
	const waits = [];
	for (let i = 0; i < 100; i++) waits.push(store.waitForChange(0, { signal }));
	assert.equal(listeners, 100, "one listener a wait");
	store.create(note("alpha"), write("alice"));
	await Promise.all(waits);
	assert.equal(listeners, 0, "every listener removed as its wait settled");
	const real = new AbortController();
	const aborted = store.waitForChange(1, { signal: real.signal });
	real.abort();
	await assert.rejects(aborted);
	store.create(note("beta"), write("alice"));
	await turns();
	assert.equal(await store.waitForChange(1), 2, "an aborted wait was dropped; a new one resolves at once");
});

test("local: nothing the store holds keeps a settled wait - resolved by a change, rejected by its signal, by a signal firing as its listener is added, or by a failed append - its signal collected while the store lives on", async () => {
	const memory = createMemoryStoragePort();
	let failing = false;
	const storage = { load: () => memory.load(), append: (record) => { if (failing) throw new Error("disk full"); memory.append(record); } };
	const store = open(storage);
	store.create(note("alpha"), write("alice"));
	const settledBy = {
		async change() {
			const signal = plainSignal();
			const waiting = store.waitForChange(store.read({ target: { id: "e1.1" } }).answer.position, { signal });
			store.create(note(`n-${++writes}`), write("alice"));
			await waiting;
			return new WeakRef(signal);
		},
		async signal() {
			const signal = plainSignal();
			const waiting = store.waitForChange(1_000_000, { signal });
			signal.fire(new Error("stop"));
			await waiting.catch(() => undefined);
			return new WeakRef(signal);
		},
		async "signal firing as its listener is added"() {
			const signal = plainSignal({ fireOnAdd: true });
			await store.waitForChange(1_000_000, { signal }).catch(() => undefined);
			return new WeakRef(signal);
		},
		async "throw from adding its listener"() {
			const signal = plainSignal();
			signal.addEventListener = () => { throw new Error("cannot listen"); };
			try {
				store.waitForChange(1_000_000, { signal });
			} catch {
				// Thrown, with no wait held.
			}
			return new WeakRef(signal);
		},
	};
	for (const [how, settle] of Object.entries(settledBy)) assert.ok(await collected(await settle()), `a wait settled by a ${how} is not held`);
	// The signal made in a function of its own, so no binding here keeps it.
	const start = () => {
		const signal = plainSignal();
		return { waiting: store.waitForChange(1_000_000, { signal }).catch(() => undefined), weak: new WeakRef(signal) };
	};
	const { waiting, weak } = start();
	failing = true;
	assert.throws(() => store.create(note("omega"), write("alice")), (e) => e?.code === "store-stopped");
	await waiting;
	assert.ok(await collected(weak), "a wait rejected by a failed append is not held");
	assert.throws(() => store.waitForChange(0), (e) => e?.code === "store-stopped", "the store lives on, stopped");
});

test("local: waitForChange on a stopped store throws store-stopped", () => {
	const memory = createMemoryStoragePort();
	let failing = false;
	const storage = { load: () => memory.load(), append: (record) => { if (failing) throw new Error("disk full"); memory.append(record); } };
	const store = open(storage);
	failing = true;
	assert.throws(() => store.create(note("alpha"), write("alice")), (e) => e?.code === "store-stopped");
	assert.throws(() => store.waitForChange(0), (e) => e?.code === "store-stopped", "a wait on a stopped store throws");
});
