// find-by-kind-tags - find every entity matching a kind and any set of tags, with the position the answer
// reflects (zorg's target, EM2, and the store's part of EM10's find: pages by bytes as of one position).
//
// Runs the shared suite's cases for this row locally, then shows that a find as of the current position
// changes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness } from "../support/local-harness.js";
import { note, openLocal } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["find-by-kind-tags"]);

test("local: a find as of the store's position appends nothing, and what it returns cannot change the store", () => {
	const { store, storage } = openLocal();
	store.create(note("alpha", ["a:b"]), { writer: "a", writeId: "1" });
	const before = storage.records();
	const found = store.find({ kind: "note", tags: ["a:b"] });
	found.answer.entries[0].tags.length = 0;
	assert.deepEqual(storage.records(), before);
	assert.deepEqual(store.find({ kind: "note", tags: ["a:b"] }).answer.entries.map((e) => e.name), ["alpha"]);
});
