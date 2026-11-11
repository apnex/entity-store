// many-item-change - the change of many writes (D4, D5), extending positioned-entity-write, repeat-recognition and
// store-refusal: 1 to 2,000 writes, no two to one entity, the change record at most 8,388,608 bytes of canonical JSON,
// each write judged as its single operation judges it against the state the writes before it leave, landing whole at
// one position or not at all, answered by the third WriteAnswer variant, { position, writes }.
//
// These are the component's own tests rather than the shared suite's: entity-api does not yet carry change, so the
// suite, which entity-api runs remotely, holds no case of it (CONTRACT.md, Carried by entity-api).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { canonicalBytes, changeDigest } from "../support/independent-canonical.js";
import { KINDS, note, openLocal, T0 } from "../support/local-store.js";

const W = (writer, writeId) => ({ writer, writeId });
const create = (input) => ({ operation: "create", input });
const update = (input) => ({ operation: "update", input });
const remove = (input) => ({ operation: "delete", input });
const at = new Date(T0).toISOString();
const body = (name) => ({ pointer: `https://example.com/${name}`, summary: `about ${name}` });

/** A store holding alpha (e1.1) and beta (e2.1), at position 2. */
function twoNotes(options = {}) {
	const local = openLocal(options);
	local.store.create(note("alpha"), W("a", "s1"));
	local.store.create(note("beta"), W("a", "s2"));
	return local;
}

const refusedWith = (outcome, code) => {
	assert.equal(outcome.outcome, "refused", `expected a refusal ${code}, got ${JSON.stringify(outcome).slice(0, 300)}`);
	assert.equal(outcome.refusal.code, code);
	assert.equal(outcome.refusal.part, "entity-store");
	for (const f of ["what", "why", "fix"]) assert.ok(typeof outcome.refusal[f] === "string" && outcome.refusal[f].length > 0, `${code}'s ${f} is a sentence`);
	return outcome.refusal;
};

test("a change of creates, updates and deletes takes one position: created entities are e<position>.<place>, the answer is { position, writes } in the order given, and one change record holds every write", () => {
	const { store, storage } = twoNotes();
	const before = storage.records();
	const input = { writes: [
		create(note("gamma")),
		update({ target: { id: "e1.1" }, tags: ["k:v"] }),
		remove({ target: { kind: "note", name: "beta" } }),
		create(note("delta", ["x:y"])),
	] };
	const out = store.change(input, W("bob", "c1"));
	assert.equal(out.outcome, "answered", JSON.stringify(out));
	const stamp = { position: 3, at, writer: "bob" };
	const gamma = { id: "e3.1", kind: "note", name: "gamma", tags: [], body: body("gamma"), revision: 1, created: stamp, changed: stamp };
	const alpha = { id: "e1.1", kind: "note", name: "alpha", tags: ["k:v"], body: body("alpha"), revision: 2, created: { position: 1, at, writer: "a" }, changed: stamp };
	const delta = { id: "e3.4", kind: "note", name: "delta", tags: ["x:y"], body: body("delta"), revision: 1, created: stamp, changed: stamp };
	const answer = { position: 3, writes: [{ entity: gamma }, { entity: alpha }, { deleted: { id: "e2.1", kind: "note", name: "beta", revision: 2 } }, { entity: delta }] };
	assert.deepEqual(out.answer, answer);
	const added = storage.records().slice(before.length);
	assert.equal(added.length, 1, "one record appended");
	assert.deepEqual(added[0], {
		type: "change", position: 3, at, writer: "bob", writeId: "c1", digest: changeDigest(input, "bob"), answer,
		writes: [{ operation: "create", id: "e3.1", entity: gamma }, { operation: "update", id: "e1.1", entity: alpha }, { operation: "delete", id: "e2.1", entity: null }, { operation: "create", id: "e3.4", entity: delta }],
	});
	assert.deepEqual(Object.keys(added[0]), ["type", "position", "at", "writer", "writeId", "digest", "answer", "writes"], "the record holds exactly the fields a change record without a note holds");
	assert.equal(store.historyBound().answer.position, 3, "four writes, one position");
	assert.deepEqual(store.read({ target: { kind: "note", name: "delta" } }).answer.entity, delta);
	assert.equal(store.read({ target: { id: "e2.1" } }).answer.entity, null);
	assert.deepEqual(store.find({ kind: "note" }).answer.entries.map((e) => e.id), ["e1.1", "e3.4", "e3.1"]);
	assert.equal(store.create(note("eta"), W("a", "s3")).answer.entity.id, "e4.1", "the next change takes the next position");
});

test("a change of one write lands, and its answer is still { position, writes }", () => {
	const { store } = openLocal();
	const out = store.change({ writes: [create(note("solo"))] }, W("a", "c1"));
	assert.equal(out.outcome, "answered");
	assert.deepEqual(Object.keys(out.answer), ["position", "writes"]);
	assert.equal(out.answer.position, 1);
	assert.equal(out.answer.writes.length, 1);
	assert.equal(out.answer.writes[0].entity.id, "e1.1");
});

test("2,000 writes land at one position, e<position>.1 to e<position>.2000; 0 writes is refused as empty-change and 2,001 as too-many-writes, naming the count and the limit, and neither appends anything", () => {
	const many = (n) => ({ writes: Array.from({ length: n }, (_, i) => create({ kind: "any", name: `n-${i + 1}`, tags: [], body: i })) });
	{
		const { store, storage } = openLocal();
		const out = store.change(many(2000), W("a", "c1"));
		assert.equal(out.outcome, "answered");
		assert.equal(out.answer.position, 1);
		assert.equal(out.answer.writes.length, 2000);
		assert.equal(out.answer.writes[1999].entity.id, "e1.2000");
		assert.equal(storage.records().filter((r) => r.type === "change").length, 1);
		assert.equal(store.read({ target: { kind: "any", name: "n-2000" } }).answer.entity.id, "e1.2000");
		assert.equal(store.changes({ since: 0 }).answer.changes.length, 2000, "one item for each write");
	}
	{
		const { store, storage } = openLocal();
		const refusal = refusedWith(store.change({ writes: [] }, W("a", "c0")), "empty-change");
		assert.deepEqual(refusal.details, {});
		const over = refusedWith(store.change(many(2001), W("a", "c2")), "too-many-writes");
		assert.deepEqual(over.details, { count: 2001, limit: 2000 });
		assert.deepEqual(storage.records(), [], "nothing was appended");
		assert.equal(store.historyBound().answer.position, 0);
	}
});

test("a change record of exactly 8,388,608 bytes of canonical JSON lands, and one a byte larger is refused as change-too-large, naming its size and the limit, appending nothing", () => {
	const LIMIT = 8_388_608;
	const writer = "alice";
	const build = (bodies, writeId) => {
		const stamp = { position: 1, at, writer };
		const entities = bodies.map((b, i) => ({ id: `e1.${i + 1}`, kind: "any", name: `big-${i + 1}`, tags: [], body: b, revision: 1, created: stamp, changed: stamp }));
		const input = { writes: entities.map((e) => create({ kind: "any", name: e.name, tags: [], body: e.body })) };
		const record = { type: "change", position: 1, at, writer, writeId, digest: changeDigest(input, writer), answer: { position: 1, writes: entities.map((entity) => ({ entity })) }, writes: entities.map((entity) => ({ operation: "create", id: entity.id, entity })) };
		return { input, record };
	};
	// Sixteen bodies of 250,000 bytes and a seventeenth sized to reach the limit; each body is in the record twice
	// (the answer and the writes), so the write identity, held once, takes up the odd byte.
	const fixed = Array.from({ length: 16 }, () => "x".repeat(250_000));
	const base = canonicalBytes(build([...fixed, ""], "w").record);
	const needed = LIMIT - base;
	const last = "y".repeat(Math.floor(needed / 2));
	const writeId = `w${"-".repeat(needed % 2)}`;
	const exact = build([...fixed, last], writeId);
	assert.equal(canonicalBytes(exact.record), LIMIT, "the fixture's record is exactly the limit");
	{
		const { store, storage } = openLocal({ maxEntityBytes: 262_144 });
		const out = store.change(exact.input, W(writer, writeId));
		assert.equal(out.outcome, "answered", JSON.stringify(out).slice(0, 300));
		const [record] = storage.records();
		assert.deepEqual(record, exact.record, "the record is the one the fixture states");
		assert.equal(canonicalBytes(record), LIMIT, "the record the store appended is exactly 8,388,608 bytes");
	}
	{
		const { store, storage } = openLocal({ maxEntityBytes: 262_144 });
		const over = build([...fixed, last], `${writeId}+`);
		assert.equal(canonicalBytes(over.record), LIMIT + 1);
		const refusal = refusedWith(store.change(over.input, W(writer, `${writeId}+`)), "change-too-large");
		assert.deepEqual(refusal.details, { bytes: LIMIT + 1, limit: LIMIT });
		assert.deepEqual(storage.records(), []);
	}
});

test("a change far beyond 8,388,608 bytes is refused as change-too-large, naming the record's exact size", () => {
	const { store, storage } = openLocal({ maxEntityBytes: 262_144 });
	const writer = "alice";
	const stamp = { position: 1, at, writer };
	const entities = Array.from({ length: 48 }, (_, i) => ({ id: `e1.${i + 1}`, kind: "any", name: `big-${i + 1}`, tags: [], body: "q".repeat(250_000), revision: 1, created: stamp, changed: stamp }));
	const input = { writes: entities.map((e) => create({ kind: "any", name: e.name, tags: [], body: e.body })), note: { size: "large" } };
	const record = { type: "change", position: 1, at, writer, writeId: "far", digest: changeDigest(input, writer), answer: { position: 1, writes: entities.map((entity) => ({ entity })) }, writes: entities.map((entity) => ({ operation: "create", id: entity.id, entity })), note: input.note };
	const refusal = refusedWith(store.change(input, W(writer, "far")), "change-too-large");
	assert.deepEqual(refusal.details, { bytes: canonicalBytes(record), limit: 8_388_608 });
	assert.ok(refusal.details.bytes > 24_000_000);
	assert.deepEqual(storage.records(), []);
});

test("two writes to one entity are refused as duplicate-target, naming the write, the earlier write and the entity, whether by identity, by kind and name, or by a name the change gave it", () => {
	const cases = [
		["by identity twice", [update({ target: { id: "e1.1" }, tags: ["a:b"] }), remove({ target: { id: "e1.1" } })], "e1.1"],
		["by identity, then by kind and name", [update({ target: { id: "e1.1" }, tags: ["a:b"] }), update({ target: { kind: "note", name: "alpha" }, tags: ["c:d"] })], "e1.1"],
		["by the name an earlier write gave it", [update({ target: { id: "e1.1" }, name: "omega" }), remove({ target: { kind: "note", name: "omega" } })], "e1.1"],
		["an entity the change created", [create(note("gamma")), update({ target: { kind: "note", name: "gamma" }, tags: ["a:b"] })], "e3.1"],
		["an entity an earlier write deleted, by identity", [remove({ target: { id: "e2.1" } }), update({ target: { id: "e2.1" }, tags: ["a:b"] })], "e2.1"],
	];
	for (const [label, writes, id] of cases) {
		const { store, storage } = twoNotes();
		const before = storage.records();
		const refusal = refusedWith(store.change({ writes: [create(note("first")), ...writes] }, W("bob", "c1")), "duplicate-target");
		const expectedId = id === "e3.1" ? "e3.2" : id;
		assert.deepEqual(refusal.details, { index: 2, earlierIndex: 1, id: expectedId }, label);
		assert.deepEqual(storage.records(), before, `${label}: nothing appended`);
		assert.equal(store.historyBound().answer.position, 2, `${label}: no position taken`);
	}
});

test("a name colliding within the change is refused as name-taken, judged against the names the writes before it leave, and a name freed earlier in the change may be taken later", () => {
	const collisions = [
		["a rename to a name an earlier create took", [create(note("omega")), update({ target: { id: "e1.1" }, name: "omega" })], "e3.1"],
		["a create of a name an earlier rename took", [update({ target: { id: "e1.1" }, name: "omega" }), create(note("omega"))], "e1.1"],
		["two renames to one name", [update({ target: { id: "e1.1" }, name: "omega" }), update({ target: { id: "e2.1" }, name: "omega" })], "e1.1"],
	];
	for (const [label, writes, holder] of collisions) {
		const { store, storage } = twoNotes();
		const before = storage.records();
		const refusal = refusedWith(store.change({ writes }, W("bob", "c1")), "name-taken");
		assert.deepEqual(refusal.details, { kind: "note", name: "omega", id: holder, index: 1 }, label);
		assert.deepEqual(storage.records(), before, `${label}: nothing appended`);
	}
	const { store, storage } = twoNotes();
	const out = store.change({ writes: [
		update({ target: { id: "e1.1" }, name: "omega" }),
		create(note("alpha")),
		remove({ target: { id: "e2.1" } }),
		create(note("beta")),
	] }, W("bob", "c2"));
	assert.equal(out.outcome, "answered", JSON.stringify(out));
	const names = (s) => Object.fromEntries(["alpha", "beta", "omega"].map((n) => [n, s.read({ target: { kind: "note", name: n } }).answer.entity?.id ?? null]));
	assert.deepEqual(names(store), { alpha: "e3.2", beta: "e3.4", omega: "e1.1" });
	const reopened = openEntityStore({ storage, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
	assert.equal(reopened.opened, true);
	assert.deepEqual(names(reopened.store), { alpha: "e3.2", beta: "e3.4", omega: "e1.1" }, "the names are the same after replay");
});

test("one refused write refuses the whole change, naming its index and its single operation's refusal, and leaves the store untouched", () => {
	const cases = [
		["revision-moved", [create(note("gamma")), update({ target: { id: "e1.1" }, expectedRevision: 7, tags: ["a:b"] })], 1, { expected: 7, current: 1, index: 1 }],
		["misfit", [create(note("gamma")), update({ target: { id: "e1.1" }, tags: ["a:b"] }), create({ kind: "note", name: "bad", tags: [], body: { summary: "no pointer" } })], 2, undefined],
		["not-found", [create(note("gamma")), update({ target: { id: "e1.1" }, tags: ["a:b"] }), create(note("delta")), remove({ target: { id: "e9.9" } })], 3, { target: { id: "e9.9" }, index: 3 }],
		["unknown-kind", [create(note("gamma")), create({ kind: "nope", name: "x", tags: [], body: 1 })], 1, { kind: "nope", index: 1 }],
		["entity-too-large", [create(note("gamma")), create({ kind: "any", name: "big", tags: [], body: "z".repeat(70_000) })], 1, { bytes: undefined, limit: 65_536, index: 1 }],
	];
	for (const [code, writes, index, details] of cases) {
		const { store, storage } = twoNotes();
		const before = storage.records();
		const refusal = refusedWith(store.change({ writes }, W("bob", "c1")), code);
		assert.equal(refusal.details.index, index, `${code} names the write's index`);
		if (code === "misfit") assert.ok(Array.isArray(refusal.misfits) && refusal.misfits.length > 0, "a misfit carries shape-check's records");
		else if (code === "entity-too-large") assert.deepEqual({ ...refusal.details, bytes: undefined }, details);
		else assert.deepEqual(refusal.details, details, code);
		assert.deepEqual(storage.records(), before, `${code}: nothing appended`);
		assert.equal(store.historyBound().answer.position, 2, `${code}: no position taken`);
		assert.equal(store.read({ target: { kind: "note", name: "gamma" } }).answer.entity, null, `${code}: the earlier create did not land`);
		assert.equal(store.read({ target: { id: "e1.1" } }).answer.entity.revision, 1, `${code}: the earlier update did not land`);
		assert.equal(store.create(note("gamma"), W("a", "after")).answer.entity.id, "e3.1", `${code}: the name and the position are still free`);
	}
});

test("each write is judged against the state the writes before it leave: an update by the revision it expects, and a delete followed by a create of its name", () => {
	const { store } = twoNotes();
	const out = store.change({ writes: [
		update({ target: { id: "e1.1" }, expectedRevision: 1, body: { summary: "changed" } }),
		remove({ target: { kind: "note", name: "beta" }, expectedRevision: 1 }),
		create(note("beta", ["n:new"])),
	] }, W("bob", "c1"));
	assert.equal(out.outcome, "answered", JSON.stringify(out));
	assert.deepEqual(out.answer.writes[0].entity.body, { pointer: "https://example.com/alpha", summary: "changed" }, "an update merges as the single operation does");
	assert.equal(out.answer.writes[0].entity.revision, 2);
	assert.deepEqual(out.answer.writes[1].deleted, { id: "e2.1", kind: "note", name: "beta", revision: 2 });
	assert.equal(out.answer.writes[2].entity.id, "e3.3");
	assert.equal(store.read({ target: { kind: "note", name: "beta" } }).answer.entity.id, "e3.3");
});

test("a repeat of a change under its write identity takes no second position and answers with a copy of the first answer; the identity with another change, another writer or a single write is identity-reused", () => {
	const { store, storage } = twoNotes();
	const input = { writes: [create(note("gamma")), update({ target: { id: "e1.1" }, tags: ["a:b"] })] };
	const first = store.change(input, W("bob", "c1"));
	assert.equal(first.outcome, "answered");
	const records = storage.records().length;
	const repeat = store.change(structuredClone(input), W("bob", "c1"));
	assert.deepEqual(repeat, first);
	repeat.answer.writes[0].entity.name = "mangled";
	assert.deepEqual(store.change(input, W("bob", "c1")), first, "the repeat's answer was a copy");
	assert.equal(storage.records().length, records, "no record appended");
	assert.equal(store.historyBound().answer.position, 3);
	const other = refusedWith(store.change({ writes: [create(note("delta"))] }, W("bob", "c1")), "identity-reused");
	assert.deepEqual(other.details, { writeId: "c1" });
	refusedWith(store.change(input, W("carol", "c1")), "identity-reused");
	refusedWith(store.create(note("zeta"), W("bob", "c1")), "identity-reused");
	assert.equal(store.create(note("eta"), W("bob", "s9")).outcome, "answered");
	refusedWith(store.change({ writes: [create(note("eta"))] }, W("bob", "s9")), "identity-reused");
	assert.equal(storage.records().length, records + 1, "only the single create landed");
});

test("the repeat check covers a change: none, recognised with the first answer, or identity-reused, making no change", () => {
	const { store, storage } = twoNotes();
	const input = { writes: [create(note("gamma")), remove({ target: { id: "e2.1" } })] };
	assert.deepEqual(store.checkRepeat("change", input, W("bob", "c1")), { repeat: "none" });
	const first = store.change(input, W("bob", "c1"));
	const records = storage.records().length;
	assert.deepEqual(store.checkRepeat("change", input, W("bob", "c1")), { repeat: "recognised", answer: first.answer });
	const reused = store.checkRepeat("change", { writes: [create(note("delta"))] }, W("bob", "c1"));
	assert.equal(reused.repeat, "identity-reused");
	assert.deepEqual(reused.refusal.details, { writeId: "c1" });
	assert.equal(store.checkRepeat("create", note("gamma"), W("bob", "c1")).repeat, "identity-reused", "a single write under a change's identity");
	assert.equal(storage.records().length, records);
});

test("a change is replayed whole when the store opens again over its file, and a repeat of it is still recognised", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-change-"));
	const file = path.join(dir, "changes.log");
	const open = () => {
		const port = createFileStoragePort(file);
		const opening = openEntityStore({ storage: port, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.equal(opening.opened, true, JSON.stringify(opening.refusal));
		return { store: opening.store, port };
	};
	try {
		const a = open();
		a.store.create(note("alpha"), W("a", "s1"));
		const input = { writes: [create(note("gamma")), update({ target: { id: "e1.1" }, name: "alpha-two" }), create({ kind: "any", name: "doc", tags: [], body: [1, 2] })] };
		const first = a.store.change(input, W("bob", "c1"));
		const changes = a.store.changes({ since: 0 }).answer;
		a.port.close();
		const bytes = fs.readFileSync(file);
		const b = open();
		assert.deepEqual(b.store.changes({ since: 0 }).answer, changes, "the same changes after replay");
		assert.equal(b.store.read({ target: { kind: "note", name: "alpha-two" } }).answer.entity.id, "e1.1");
		assert.equal(b.store.read({ target: { kind: "any", name: "doc" } }).answer.entity.id, "e2.3");
		assert.deepEqual(b.store.change(input, W("bob", "c1")), first, "the repeat is recognised after replay");
		b.port.close();
		assert.ok(fs.readFileSync(file).equals(bytes), "the repeat appended nothing");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("changes gives one item for each write of a change, in order, at its one position, and follow reports each entity entering, changing or leaving the set across the change", () => {
	const { store } = openLocal();
	store.create(note("alpha", ["t:a"]), W("a", "s1"));
	store.create(note("beta", ["t:a"]), W("a", "s2"));
	store.change({ writes: [
		update({ target: { id: "e1.1" }, tags: [] }),
		create(note("gamma", ["t:a"])),
		update({ target: { id: "e2.1" }, body: { summary: "changed" } }),
	] }, W("bob", "c1"));
	const items = store.changes({ since: 2 }).answer.changes;
	assert.deepEqual(items.map((i) => [i.id, i.revision, i.changed.position]), [["e1.1", 2, 3], ["e3.2", 1, 3], ["e2.1", 2, 3]]);
	const follow = store.follow({ kind: "note", tags: ["t:a"], since: 2 }).answer;
	assert.deepEqual(follow.changes.map((i) => [i.event, i.id, i.position, i.writer]), [["leaving", "e1.1", 3, "bob"], ["entering", "e3.2", 3, "bob"], ["changing", "e2.1", 3, "bob"]]);
	assert.equal(follow.through, 3);
});

test("an input that does not fit change's shape, or a write whose input does not fit its operation's shape, is a programming error, thrown naming the field, and appends nothing", () => {
	const { store, storage } = twoNotes();
	const before = storage.records();
	const write = W("a", "c1");
	const naming = (field) => (e) => e instanceof TypeError && e.message.includes(field);
	assert.throws(() => store.change({ writes: "x" }, write), naming("/writes"), "writes that is not a list");
	assert.throws(() => store.change({}, write), naming("/writes"), "no writes");
	assert.throws(() => store.change({ writes: [{ operation: "upsert", input: {} }] }, write), naming("/writes/0/operation"), "an operation that is not create, update or delete");
	assert.throws(() => store.change({ writes: [{ operation: "create" }] }, write), naming("/writes/0/input"), "a write without its input");
	assert.throws(() => store.change({ writes: [create(note("ok")), create({ kind: "note", name: "a", body: 1 })] }, write), naming("/writes/1/input/tags"), "a create without tags, the field named");
	assert.throws(() => store.change({ writes: [update({ target: { id: "e1.1" }, name: "b", writer: "bob" })] }, write), naming("/writes/0/input/writer"), "a write carrying a writer");
	assert.throws(() => store.change({ writes: [create(note("ok"))], writer: "bob" }, write), naming("/writer"), "a change carrying a writer");
	assert.throws(() => store.change({ writes: [create(note("ok"))], expectedPosition: 1.5 }, write), naming("/expectedPosition"), "an expected position that is not an integer");
	assert.throws(() => store.change([create(note("ok"))], write), TypeError, "a list rather than the change's input");
	assert.throws(() => store.change({ writes: [create(note("ok"))] }, { writer: "a" }), TypeError, "a change without its write identity");
	assert.throws(() => store.change({ writes: [create({ kind: "note", name: "a", tags: [], body: undefined })] }, write), TypeError, "a body that is not JSON");
	assert.deepEqual(storage.records(), before, "nothing was appended");
});

test("a change log holding a change of many writes answered by the third variant opens, and one whose answer is malformed stops the store opening, naming its line", () => {
	const stamp = { position: 1, at, writer: "fixture" };
	const entity = (n, name) => ({ id: `e1.${n}`, kind: "note", name, tags: [], body: body(name), revision: 1, created: stamp, changed: stamp });
	const record = (answer) => ({ type: "change", position: 1, at, writer: "fixture", writeId: "two", digest: "0".repeat(64), answer,
		writes: [{ operation: "create", id: "e1.1", entity: entity(1, "first") }, { operation: "create", id: "e1.2", entity: entity(2, "second") }] });
	const opening = (answer) => {
		const storage = createMemoryStoragePort();
		storage.append(record(answer));
		return openEntityStore({ storage, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
	};
	const good = opening({ position: 1, writes: [{ entity: entity(1, "first") }, { entity: entity(2, "second") }] });
	assert.equal(good.opened, true, JSON.stringify(good.refusal));
	assert.equal(good.store.read({ target: { id: "e1.2" } }).answer.entity.name, "second");
	for (const [label, answer] of [
		["no writes", { position: 1, writes: [] }],
		["an answer item with both an entity and a deleted", { position: 1, writes: [{ entity: entity(1, "first"), deleted: { id: "e1.1", kind: "note", name: "first", revision: 2 } }, { entity: entity(2, "second") }] }],
		["an answer item that is not an envelope", { position: 1, writes: [{ entity: 5 }, { entity: entity(2, "second") }] }],
		["fewer answers than writes", { position: 1, writes: [{ entity: entity(1, "first") }] }],
		["an extra field", { position: 1, writes: [{ entity: entity(1, "first") }, { entity: entity(2, "second") }], more: 1 }],
	]) {
		const bad = opening(answer);
		assert.equal(bad.opened, false, label);
		assert.equal(bad.refusal.code, "log-corrupt", label);
		assert.equal(bad.refusal.details.line, 2, label);
	}
});
