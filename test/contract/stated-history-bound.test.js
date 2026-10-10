// stated-history-bound - history is kept to a bound the application states, any reader can read the
// bound, and a reader behind it is told so (zorg's target, EM8; E4).
//
// Runs the shared suite's cases for this row locally - including EM8's schedule with a find as of 0 at
// 2000, refused before and after a restart with the clock set back, and as of 1 answered - then shows in
// the change log the time records EM8 makes the store append before each decision about retention. The
// same schedule also runs on the file port in a child process that is really killed, and the store is
// reopened with the clock set back.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { runUntilReadyThenKill } from "../support/child-process.js";
import { createLocalHarness } from "../support/local-harness.js";
import { note, openLocal, T0 } from "../support/local-store.js";
import { SCHEDULE } from "../support/schedule.js";

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

test("file port, process killed: changes at 1000 and 1900 with a bound of 1000, a find as of 0 at 2000 refused as position-not-held before the kill and after it, the clock set back to 1900, and as of 1 answered", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-schedule-"));
	try {
		const file = path.join(dir, "changes.log");
		const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "support", "schedule-child.js");
		const [first, second, found] = await runUntilReadyThenKill(child, [file, "find"], path.join(dir, "acks"));
		assert.deepEqual([first.outcome.answer.position, second.outcome.answer.position], [1, 2], "the changes at 1000 and 1900 were acknowledged");
		assert.equal(found.outcome.outcome, "refused", "the find as of 0 at 2000 was refused before the kill");
		assert.equal(found.outcome.refusal.code, "position-not-held");
		assert.deepEqual(found.outcome.refusal.details, { position: 0 });
		const timeRecords = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"type":"time"'));
		assert.deepEqual(timeRecords.map((l) => JSON.parse(l).at), ["1970-01-01T00:00:02.000Z"], "the decision at 2000 reached the change log before the kill");

		const { store, storage } = openLocal({ storage: createFileStoragePort(file), time: 1900, historyMs: SCHEDULE.historyMs });
		try {
			const after = store.find({ kind: "note", asOf: 0 });
			assert.deepEqual([after.outcome, after.refusal?.code, after.refusal?.details], ["refused", "position-not-held", { position: 0 }], "refused after the kill, the store's time being 2000, not the clock's 1900");
			assert.deepEqual(store.find({ kind: "note", asOf: 1 }), { outcome: "answered", answer: { position: 1, entries: [first.outcome.answer.entity], next: null } }, "as of 1 is answered with the state as of 1");
			assert.equal(store.historyBound().answer.position, 2);
		} finally {
			storage.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
