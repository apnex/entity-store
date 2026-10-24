// change-provenance - each change records when it was made and the writer the application names,
// unchecked (zorg's target, EM5 and EM6's time; D13).
//
// Runs the shared suite's cases for this row locally, then the cases a host would never produce: writers
// no host names, and a clock port giving times the wall clock never would, which shows the store's time
// comes from the port it is given. Last, EM8's clock range on both storage ports: changes, time records and
// repeats written and recovered at both ends of the range, and a value one millisecond outside either end
// thrown, on an empty store and after a change logged at a later time.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMemoryStoragePort } from "@apnex/entity-store";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { createLocalHarness } from "../support/local-harness.js";
import { note, openLocal, T0 } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["change-provenance"]);

test("local: the writer is recorded exactly as the application names it, unchecked, in the envelope and the change log", () => {
	const { store, storage } = openLocal();
	const writers = ["Not A Name!", "", "x".repeat(300), "\u00e9crivain \u{1F600}", "alice"];
	for (const [i, writer] of writers.entries()) {
		const made = store.create(note(`w${i}`), { writer, writeId: `w${i}` });
		assert.equal(made.outcome, "answered");
		assert.deepEqual([made.answer.entity.created.writer, made.answer.entity.changed.writer], [writer, writer]);
	}
	assert.deepEqual(storage.records().filter((r) => r.type === "change").map((r) => r.writer), writers, "each change record carries its writer");
});

test("local: a change's time comes from the clock port the application supplies, never the wall clock", () => {
	const { store, storage, clock } = openLocal({ time: 0 });
	assert.equal(store.create(note("epoch"), { writer: "a", writeId: "1" }).answer.entity.created.at, "1970-01-01T00:00:00.000Z");
	assert.deepEqual(storage.records().map((r) => [r.type, r.at]), [["change", "1970-01-01T00:00:00.000Z"]], "the first change record carries its time");
	clock.set(Date.UTC(2101, 0, 1, 0, 0, 0, 7));
	const later = store.update({ target: { id: "e1.1" }, tags: ["a:b"] }, { writer: "b", writeId: "2" }).answer.entity;
	assert.equal(later.changed.at, "2101-01-01T00:00:00.007Z");
	assert.equal(later.created.at, "1970-01-01T00:00:00.000Z");
	assert.deepEqual(storage.records().map((r) => [r.type, r.at]), [["base", "1970-01-01T00:00:00.000Z"], ["change", "2101-01-01T00:00:00.007Z"]], "after 131 years the first change is compacted to base with its time, and the second carries its time");
});

// EM8's clock range: whole milliseconds from 0000-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z.
const MIN = -62167219200000;
const MAX = 253402300799999;
const iso = (ms) => new Date(ms).toISOString();
const times = (records) => records.filter((r) => r.type === "time").map((r) => r.at);

/**
 * The two storage ports, each as a way to open a store again on what it kept - the memory port by
 * abandoning the store unclosed, the file port with a new port on the same change log - and to list the
 * records it holds.
 */
const PORTS = {
	memory() {
		const port = createMemoryStoragePort();
		return { port: () => port, records: () => port.records(), done() {} };
	},
	file() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-clock-"));
		const file = path.join(dir, "changes.log");
		const opened = [];
		return {
			port: () => { opened.push(createFileStoragePort(file)); return opened.at(-1); },
			records: () => fs.readFileSync(file, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l)),
			done() { for (const p of opened) p.close(); fs.rmSync(dir, { recursive: true, force: true }); },
		};
	},
};

const throwsOutOfRange = (call, what) => assert.throws(call, (e) => e instanceof RangeError && /clock/.test(e.message), what);

for (const [portName, makePort] of Object.entries(PORTS)) {
	test(`${portName} port: at the lower end of the clock's range a change, a time record and a repeat are written and recovered`, () => {
		const ports = makePort();
		try {
			const first = openLocal({ storage: ports.port(), time: MIN, historyMs: 1000 });
			const created = first.store.create(note("alpha"), { writer: "a", writeId: "w1" });
			assert.equal(created.answer.entity.created.at, "0000-01-01T00:00:00.000Z", "a change at the first time of the range");
			first.clock.set(MIN + 1.5);
			assert.deepEqual(first.store.create(note("alpha"), { writer: "a", writeId: "w1" }), created, "its repeat a millisecond later is recognised");
			const updated = first.store.update({ target: { id: "e1.1" }, tags: ["a:b"] }, { writer: "b", writeId: "w2" });
			assert.equal(updated.answer.entity.changed.at, "0000-01-01T00:00:00.001Z", "a fractional clock is floored");
			assert.deepEqual(times(ports.records()), ["0000-01-01T00:00:00.001Z"], "the repeat's decision appended a time record");
			assert.deepEqual(ports.records().filter((r) => r.type === "change").map((r) => r.at), ["0000-01-01T00:00:00.000Z", "0000-01-01T00:00:00.001Z"]);
			const again = openLocal({ storage: ports.port(), time: MIN, historyMs: 1000 });
			assert.deepEqual(again.store.read({ target: { id: "e1.1" } }).answer, { position: 2, entity: updated.answer.entity }, "recovered");
			assert.deepEqual(again.store.create(note("alpha"), { writer: "a", writeId: "w1" }), created, "the first repeat is recognised after recovery");
			assert.deepEqual(again.store.update({ target: { id: "e1.1" }, tags: ["a:b"] }, { writer: "b", writeId: "w2" }), updated, "the second too");
			assert.equal(again.store.historyBound().answer.position, 2, "no repeat took a position");
			assert.equal(again.store.find({ kind: "note", asOf: 1 }).outcome, "answered", "the store's time is the log's, MIN + 1, so position 1 is held");
		} finally {
			ports.done();
		}
	});

	test(`${portName} port: at the upper end of the clock's range a change, a time record and a repeat are written and recovered`, () => {
		const ports = makePort();
		try {
			const first = openLocal({ storage: ports.port(), time: MAX - 1, historyMs: 1000 });
			const created = first.store.create(note("alpha"), { writer: "a", writeId: "w1" });
			assert.equal(created.answer.entity.created.at, "9999-12-31T23:59:59.998Z");
			first.clock.set(MAX + 0.9);
			assert.deepEqual(first.store.create(note("alpha"), { writer: "a", writeId: "w1" }), created, "its repeat at the last time of the range is recognised");
			assert.deepEqual(times(ports.records()), ["9999-12-31T23:59:59.999Z"], "a time record at the last time of the range");
			const updated = first.store.update({ target: { id: "e1.1" }, tags: ["a:b"] }, { writer: "b", writeId: "w2" });
			assert.equal(updated.answer.entity.changed.at, "9999-12-31T23:59:59.999Z", "a change at the last time of the range, the clock floored");
			const again = openLocal({ storage: ports.port(), time: MAX, historyMs: 1000 });
			assert.deepEqual(again.store.read({ target: { id: "e1.1" } }).answer, { position: 2, entity: updated.answer.entity }, "recovered");
			assert.deepEqual(again.store.create(note("alpha"), { writer: "a", writeId: "w1" }), created, "the first repeat is recognised after recovery");
			assert.deepEqual(again.store.update({ target: { id: "e1.1" }, tags: ["a:b"] }, { writer: "b", writeId: "w2" }), updated, "the second too");
			assert.equal(again.store.historyBound().answer.position, 2, "no repeat took a position");
			const third = openLocal({ storage: ports.port(), time: T0, historyMs: 1000 });
			assert.deepEqual(third.store.create(note("alpha"), { writer: "a", writeId: "w1" }), created, "with the clock set back the store's time is still the log's");
		} finally {
			ports.done();
		}
	});

	test(`${portName} port: a clock one millisecond outside either end of the range throws, on an empty store, appending nothing`, () => {
		const ports = makePort();
		try {
			const { store, clock } = openLocal({ storage: ports.port(), time: MIN - 1, historyMs: 1000 });
			for (const [value, what] of [[MIN - 1, "MIN - 1"], [MIN - 0.5, "MIN - 0.5, floored to MIN - 1"], [MAX + 1, "MAX + 1"], [-8640000000000001, "below Date's range"], [8640000000000001, "above Date's range"]]) {
				clock.set(value);
				throwsOutOfRange(() => store.create(note("alpha"), { writer: "a", writeId: "w1" }), `a create, the clock at ${what}`);
				throwsOutOfRange(() => store.checkRepeat("create", note("alpha"), { writer: "a", writeId: "w1" }), `a repeat check, the clock at ${what}`);
			}
			for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
				clock.set(value);
				assert.throws(() => store.create(note("alpha"), { writer: "a", writeId: "w1" }), TypeError, `a clock at ${value}`);
			}
			assert.deepEqual(ports.records(), [], "nothing was appended");
			assert.equal(store.historyBound().answer.position, 0);
			clock.set(MIN);
			assert.equal(store.create(note("alpha"), { writer: "a", writeId: "w1" }).outcome, "answered", "the store still answers once the clock is in range");
		} finally {
			ports.done();
		}
	});

	test(`${portName} port: a clock one millisecond outside either end throws after a change logged at a later time, before any repeat or find is decided`, () => {
		const ports = makePort();
		try {
			const { store, clock } = openLocal({ storage: ports.port(), time: T0, historyMs: 1000 });
			const write = { writer: "a", writeId: "w1" };
			store.create(note("alpha"), write);
			store.create(note("beta"), { writer: "a", writeId: "w2" });
			const before = ports.records();
			for (const [value, what] of [[MIN - 1, "MIN - 1"], [-8640000000000001, "below Date's range"], [MAX + 1, "MAX + 1"]]) {
				clock.set(value);
				throwsOutOfRange(() => store.create(note("alpha"), write), `a repeat of a held identity, not recognised: the clock at ${what}`);
				throwsOutOfRange(() => store.create(note("alpha"), { writer: "a", writeId: "other" }), `a write a logged time would have stamped, the clock at ${what}`);
				throwsOutOfRange(() => store.update({ target: { id: "e1.1" }, name: "beta" }, { writer: "a", writeId: "w3" }), `a write that would be refused, the clock at ${what}`);
				throwsOutOfRange(() => store.checkRepeat("create", note("alpha"), write), `a repeat check, the clock at ${what}`);
				throwsOutOfRange(() => store.find({ kind: "note", asOf: 0 }), `a find as of a position below the store's, the clock at ${what}`);
			}
			assert.deepEqual(ports.records(), before, "nothing was appended");
			clock.set(MAX);
			store.create(note("gamma"), { writer: "a", writeId: "w4" });
			clock.set(MAX + 1);
			throwsOutOfRange(() => store.create(note("gamma"), { writer: "a", writeId: "w4" }), "MAX + 1 after a change logged at MAX");
			const again = openLocal({ storage: ports.port(), time: MIN - 1, historyMs: 1000 });
			throwsOutOfRange(() => again.store.create(note("gamma"), { writer: "a", writeId: "w4" }), "MIN - 1 after recovering a change logged at MAX");
			assert.deepEqual(times(ports.records()), [], "no time record was appended for an out-of-range clock");
		} finally {
			ports.done();
		}
	});
}
