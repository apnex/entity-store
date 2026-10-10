// identity-name-lookup - read one entity by identity or by name, with the position the answer reflects
// (zorg's target, EM1, EM9's target rules and EM10's read; D22).
//
// Runs the shared suite's cases for this row locally, then shows that a read changes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness } from "../support/local-harness.js";
import { note, openLocal } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["identity-name-lookup"]);

test("local: a read appends nothing and takes no position, and what it returns cannot change the store", () => {
	const { store, storage } = openLocal();
	store.create(note("alpha"), { writer: "a", writeId: "1" });
	const before = storage.records();
	const read = store.read({ target: { kind: "note", name: "alpha" } });
	read.answer.entity.name = "changed";
	read.answer.entity.tags.push("x:y");
	assert.deepEqual(storage.records(), before);
	assert.equal(store.read({ target: { id: "e1.1" } }).answer.entity.name, "alpha", "the store's entity is its own copy");
	assert.deepEqual(store.read({ target: { id: "e1.1" } }).answer.entity.tags, []);
});
