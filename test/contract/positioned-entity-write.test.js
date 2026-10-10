// positioned-entity-write - create, update and delete entities; each change - one or more writes, applied
// all or nothing - takes exactly one position (zorg's target, EM3 and EM6; E3).
//
// Runs the shared suite's cases for this row against a store in this process, then the cases that only a
// local store can show: the change record each change appends, a change of two writes, and inputs that do
// not fit their operation's shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness } from "../support/local-harness.js";
import { KINDS, openLocal, T0 } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["positioned-entity-write"]);

test("local: each change appends one change record of one write before it answers, and a delete's write holds null", () => {
	const { store, storage } = openLocal();
	const created = store.create({ kind: "note", name: "alpha", tags: [], body: { pointer: "https://e.x/", summary: "s" } }, { writer: "alice", writeId: "w1" });
	const deleted = store.delete({ target: { id: "e1.1" } }, { writer: "alice", writeId: "w2" });
	const changes = storage.records().filter((r) => r.type === "change");
	assert.equal(changes.length, 2);
	assert.deepEqual(changes[0].writes, [{ operation: "create", id: "e1.1", entity: created.answer.entity }]);
	assert.deepEqual(changes[0].answer, created.answer);
	assert.deepEqual(changes[1].writes, [{ operation: "delete", id: "e1.1", entity: null }]);
	assert.deepEqual([changes[0].position, changes[1].position], [1, 2]);
	assert.deepEqual(changes[1].answer, deleted.answer);
});

test("local: a change of two writes takes one position, and its entities are e<position>.1 and e<position>.2 in the order written", () => {
	const storage = createMemoryStoragePort();
	const at = new Date(T0).toISOString();
	const stamp = { position: 1, at, writer: "fixture" };
	const entity = (n, name) => ({ id: `e1.${n}`, kind: "note", name, tags: [], body: { pointer: "https://e.x/", summary: name }, revision: 1, created: stamp, changed: stamp });
	storage.append({ type: "change", position: 1, at, writer: "fixture", writeId: "two", digest: "0".repeat(64), answer: { position: 1, entity: entity(1, "first") },
		writes: [{ operation: "create", id: "e1.1", entity: entity(1, "first") }, { operation: "create", id: "e1.2", entity: entity(2, "second") }] });
	const opening = openEntityStore({ storage, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
	assert.equal(opening.opened, true);
	const { store } = opening;
	assert.equal(store.historyBound().answer.position, 1, "two writes, one position");
	assert.deepEqual(store.read({ target: { id: "e1.2" } }).answer.entity, entity(2, "second"));
	assert.deepEqual(store.find({ kind: "note" }).answer.entries.map((e) => e.id), ["e1.1", "e1.2"]);
	assert.equal(store.create({ kind: "note", name: "third", tags: [], body: { pointer: "https://e.x/", summary: "t" } }, { writer: "a", writeId: "w" }).answer.entity.id, "e2.1", "the next change takes the next position");
});

test("local: an input that does not fit its operation's shape is a programming error, thrown, and takes no position", () => {
	const { store, storage } = openLocal();
	const write = { writer: "alice", writeId: "w" };
	assert.throws(() => store.create({ kind: "note", name: "a", tags: [], body: 1, writer: "bob" }, write), TypeError, "an input carrying a writer");
	assert.throws(() => store.create({ kind: "note", name: "a", body: 1 }, write), TypeError, "a create without tags");
	assert.throws(() => store.update({ target: { id: 5 } }, write), TypeError, "a target identity that is not a string");
	assert.throws(() => store.update({ target: { id: "e1.1" }, expectedRevision: 1.5, name: "x" }, write), TypeError, "an expected revision that is not an integer");
	assert.throws(() => store.find({ kind: "note", asOf: "1" }), TypeError, "a position that is not an integer");
	assert.throws(() => store.create({ kind: "note", name: "a", tags: [], body: undefined }, write), TypeError, "a body that is not JSON");
	assert.throws(() => store.create({ kind: "note", name: "a", tags: [], body: 1 }, { writer: "alice" }), TypeError, "a write without its write identity");
	assert.equal(storage.records().length, 0, "nothing was appended");
	assert.equal(store.historyBound().answer.position, 0);
});
