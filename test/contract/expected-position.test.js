// expected-position - a change, of one write or many, may name expectedPosition, the store position its writer
// last saw, and is refused as position-moved, naming the store's position, when the store's position is any other;
// repeat recognition is decided first (D4, D5), extending expected-revision-write and store-refusal.
//
// The component's own tests: entity-api does not yet carry change, so the shared suite holds no case of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note, openLocal } from "../support/local-store.js";

const W = (writer, writeId) => ({ writer, writeId });
const create = (input) => ({ operation: "create", input });
const update = (input) => ({ operation: "update", input });

test("a change naming the store's position lands; one naming any other position is refused as position-moved, naming the position expected and the store's, and appends nothing", () => {
	const { store, storage } = openLocal();
	assert.equal(store.change({ writes: [create(note("alpha"))], expectedPosition: 0 }, W("a", "c0")).outcome, "answered", "0 on an empty store");
	store.create(note("beta"), W("a", "s1"));
	const landed = store.change({ writes: [create(note("gamma")), update({ target: { id: "e1.1" }, tags: ["a:b"] })], expectedPosition: 2 }, W("a", "c1"));
	assert.equal(landed.outcome, "answered");
	assert.equal(landed.answer.position, 3);
	const before = storage.records();
	for (const expected of [2, 0, 4, 99]) {
		const out = store.change({ writes: [create(note(`late-${expected}`))], expectedPosition: expected }, W("a", `late-${expected}`));
		assert.equal(out.outcome, "refused", `expected ${expected}`);
		assert.equal(out.refusal.code, "position-moved");
		assert.equal(out.refusal.part, "entity-store");
		for (const f of ["what", "why", "fix"]) assert.ok(typeof out.refusal[f] === "string" && out.refusal[f].length > 0);
		assert.deepEqual(out.refusal.details, { expected, current: 3 });
	}
	assert.deepEqual(storage.records(), before, "nothing was appended");
	assert.equal(store.historyBound().answer.position, 3);
});

test("a change of one write may name the expected position, and without one a change is not judged by position", () => {
	const { store } = openLocal();
	store.create(note("alpha"), W("a", "s1"));
	assert.equal(store.change({ writes: [create(note("beta"))], expectedPosition: 0 }, W("a", "c1")).refusal.code, "position-moved");
	assert.equal(store.change({ writes: [create(note("beta"))], expectedPosition: 1 }, W("a", "c2")).outcome, "answered");
	assert.equal(store.change({ writes: [create(note("gamma"))] }, W("a", "c3")).outcome, "answered");
});

test("repeat recognition is decided first: a repeat of a change that landed answers with its first answer however far the store has moved since", () => {
	const { store, storage } = openLocal();
	const input = { writes: [create(note("alpha")), create(note("beta"))], expectedPosition: 0 };
	const first = store.change(input, W("a", "c1"));
	assert.equal(first.outcome, "answered");
	for (const name of ["gamma", "delta", "epsilon"]) store.create(note(name), W("a", `s-${name}`));
	const records = storage.records().length;
	assert.deepEqual(store.change(input, W("a", "c1")), first);
	assert.equal(storage.records().length, records);
	assert.equal(store.historyBound().answer.position, 4);
	assert.equal(store.change({ writes: [create(note("alpha"))], expectedPosition: 0 }, W("a", "c1")).refusal.code, "identity-reused", "another request under the identity is identity-reused, not position-moved");
});

test("the expected position is judged before any write, so a moved position is what a change is refused for even when a write would be refused too", () => {
	const { store } = openLocal();
	store.create(note("alpha"), W("a", "s1"));
	const out = store.change({ writes: [create({ kind: "nope", name: "x", tags: [], body: 1 })], expectedPosition: 0 }, W("a", "c1"));
	assert.equal(out.refusal.code, "position-moved");
});

test("a note holding an unsafe integer is refused for that before the expected position is judged, so a change with both is refused as note-unsafe-number", () => {
	const { store, storage } = openLocal();
	store.create(note("alpha"), W("a", "s1"));
	const before = storage.records();
	const out = store.change({ writes: [create(note("beta"))], expectedPosition: 0, note: { inverse: [{ n: 2 ** 53 }] } }, W("a", "c1"));
	assert.equal(out.outcome, "refused");
	assert.equal(out.refusal.code, "note-unsafe-number");
	assert.deepEqual(out.refusal.details, { pointer: "/inverse/0/n" });
	assert.equal(store.change({ writes: [create(note("beta"))], expectedPosition: 0, note: { inverse: [{ n: 2 ** 53 - 1 }] } }, W("a", "c2")).refusal.code, "position-moved", "a safe note leaves the moved position to be refused");
	assert.deepEqual(storage.records(), before, "nothing was appended");
});
