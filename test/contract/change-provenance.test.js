// change-provenance - each change records when it was made and the writer the application names,
// unchecked (zorg's target, EM5 and EM6's time; D13).
//
// Runs the shared suite's cases for this row locally, then the cases a host would never produce: writers
// no host names, and a clock port giving times the wall clock never would, which shows the store's time
// comes from the port it is given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness } from "../support/local-harness.js";
import { note, openLocal } from "../support/local-store.js";

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
	clock.set(Date.UTC(2101, 0, 1, 0, 0, 0, 7));
	const later = store.update({ target: { id: "e1.1" }, tags: ["a:b"] }, { writer: "b", writeId: "2" }).answer.entity;
	assert.equal(later.changed.at, "2101-01-01T00:00:00.007Z");
	assert.equal(later.created.at, "1970-01-01T00:00:00.000Z");
	assert.deepEqual(storage.records().filter((r) => r.type === "change").map((r) => r.at), ["1970-01-01T00:00:00.000Z", "2101-01-01T00:00:00.007Z"], "each change record carries its time");
});
