// expected-revision-write - a write may name the revision it expects, and is refused if another change got
// there first (zorg's target, EM6 and EM9's revision-moved).
//
// Runs the shared suite's cases for this row locally, then shows in the change log that a refused write
// leaves nothing behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness } from "../support/local-harness.js";
import { note, openLocal } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["expected-revision-write"]);

test("local: a write refused because its revision moved appends nothing to the change log", () => {
	const { store, storage } = openLocal();
	store.create(note("alpha"), { writer: "a", writeId: "1" });
	store.update({ target: { id: "e1.1" }, tags: ["a:b"] }, { writer: "a", writeId: "2" });
	const before = storage.records();
	const refused = store.update({ target: { id: "e1.1" }, expectedRevision: 1, tags: ["c:d"] }, { writer: "b", writeId: "3" });
	assert.equal(refused.outcome, "refused");
	assert.deepEqual(refused.refusal.details, { expected: 1, current: 2 });
	assert.equal(store.delete({ target: { id: "e1.1" }, expectedRevision: 3 }, { writer: "b", writeId: "4" }).outcome, "refused");
	assert.deepEqual(storage.records(), before, "the change log is unchanged");
});
