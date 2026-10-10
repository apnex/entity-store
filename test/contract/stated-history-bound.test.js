// stated-history-bound - history is kept to a bound the application states, any reader can read the
// bound, and a reader behind it is told so (zorg's target, EM8; E4).
//
// Runs the shared suite's cases for this row locally - including EM8's schedule with a find as of 0 at
// 2000, refused before and after a restart with the clock set back, and as of 1 answered - then shows in
// the change log the time records EM8 makes the store append before each decision about retention.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness } from "../support/local-harness.js";
import { note, openLocal, T0 } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["stated-history-bound"]);

const iso = (ms) => new Date(ms).toISOString();
const times = (storage) => storage.records().filter((r) => r.type === "time");

test("local: before deciding whether a write identity is retained, the store appends a time record when its time is later than the log's", () => {
	const { store, storage, clock } = openLocal({ historyMs: 1000 });
	const write = { writer: "a", writeId: "w" };
	store.create(note("alpha"), write);
	assert.deepEqual(times(storage), [], "a new identity needs no decision about retention");
	store.create(note("alpha"), write);
	assert.deepEqual(times(storage), [], "a repeat at the change's own time: the store's time is not later than the log's");
	clock.set(T0 + 400);
	store.create(note("alpha"), write);
	assert.deepEqual(times(storage), [{ type: "time", at: iso(T0 + 400) }], "a repeat at a later time appends that time first");
	clock.set(T0 + 100);
	store.create(note("alpha"), write);
	assert.equal(times(storage).length, 1, "with the clock set back the store's time is the log's, and nothing is appended");
});

test("local: before deciding whether a position below the store's is held, the store appends a time record; a find as of its own position needs none", () => {
	const { store, storage, clock } = openLocal({ historyMs: 1000 });
	store.create(note("alpha"), { writer: "a", writeId: "1" });
	clock.set(T0 + 50);
	store.find({ kind: "note" });
	store.find({ kind: "note", asOf: 1 });
	assert.deepEqual(times(storage), [], "a find as of the store's own position decides nothing about retention");
	store.find({ kind: "note", asOf: 0 });
	assert.deepEqual(times(storage), [{ type: "time", at: iso(T0 + 50) }]);
	const records = storage.records();
	assert.deepEqual(records.map((r) => r.type), ["change", "time"], "a time record takes no position and holds only type and at");
	assert.deepEqual(Object.keys(records[1]).sort(), ["at", "type"]);
	assert.equal(store.historyBound().answer.position, 1);
});

test("local: the bound is configuration, not stored: the change log holds no bound, and history-bound answers the bound given at opening", () => {
	const storage = openLocal({ historyMs: 1000 }).storage;
	const { store } = openLocal({ historyMs: 1000, storage });
	store.create(note("alpha"), { writer: "a", writeId: "1" });
	for (const record of storage.records()) {
		assert.deepEqual(Object.keys(record).sort(), ["answer", "at", "digest", "position", "type", "writeId", "writer", "writes"], "a change record holds EM15's fields and no bound");
	}
	assert.deepEqual(openLocal({ historyMs: 5000, storage }).store.historyBound().answer, { position: 1, historyMs: 5000 });
});
