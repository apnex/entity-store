// change-note - the note on a change (D4, D5), extending change-provenance and storage-port: plain JSON read through
// shape-check's readPlainJson, nesting at most 16 levels and at most 524,288 bytes of canonical UTF-8 JSON; kept in
// the change record in canonical form and included in its digest when present, and absent from the record when not
// given; carried once per change, on the first of its items, in changes and follow; forgotten with its change.
//
// The component's own tests: entity-api does not yet carry change, so the shared suite holds no case of it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { canonical, canonicalBytes, changeDigest } from "../support/independent-canonical.js";
import { KINDS, note, openLocal, T0 } from "../support/local-store.js";

const W = (writer, writeId) => ({ writer, writeId });
const create = (input) => ({ operation: "create", input });
const at = new Date(T0).toISOString();
const FIELDS = ["type", "position", "at", "writer", "writeId", "digest", "answer", "writes"];
const nest = (levels) => (levels === 0 ? 0 : [nest(levels - 1)]);

const refusedWith = (outcome, code) => {
	assert.equal(outcome.outcome, "refused", `expected ${code}, got ${JSON.stringify(outcome).slice(0, 300)}`);
	assert.equal(outcome.refusal.code, code);
	for (const f of ["what", "why", "fix"]) assert.ok(typeof outcome.refusal[f] === "string" && outcome.refusal[f].length > 0);
	return outcome.refusal;
};

test("a change without a note, or with a note given as undefined, records no note field, and the two are one request", () => {
	const { store, storage } = openLocal();
	const input = { writes: [create(note("alpha"))] };
	const out = store.change(input, W("a", "c1"));
	const [record] = storage.records();
	assert.deepEqual(Object.keys(record), FIELDS);
	assert.equal(Object.hasOwn(record, "note"), false);
	assert.equal(record.digest, changeDigest(input, "a"), "the digest of the request without a note");
	assert.deepEqual(store.change({ ...input, note: undefined }, W("a", "c1")), out, "a note given as undefined is no note: the same request, recognised");
	store.change({ writes: [create(note("beta"))], note: undefined }, W("a", "c2"));
	const second = storage.records()[1];
	assert.deepEqual(Object.keys(second), FIELDS);
	assert.equal(second.digest, changeDigest({ writes: [create(note("beta"))] }, "a"));
	assert.equal(store.changes({ since: 0 }).answer.changes.some((item) => Object.hasOwn(item, "note")), false, "no item carries a note");
});

test("a note is kept in the change record in canonical form, after the record's other fields, and included in the change's digest", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-note-"));
	try {
		const file = path.join(dir, "changes.log");
		const port = createFileStoragePort(file);
		const opening = openEntityStore({ storage: port, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		const { store } = opening;
		const given = { z: [3, { y: null, b: true }], "\u00e9": "\u{1F600}", a: { d: 1.5, c: -0 } };
		const input = { writes: [create(note("alpha")), create(note("beta"))], note: given };
		const out = store.change(input, W("a", "c1"));
		assert.equal(out.outcome, "answered");
		port.close();
		const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
		const record = JSON.parse(lines[1]);
		assert.deepEqual(Object.keys(record), [...FIELDS, "note"]);
		assert.deepEqual(record.note, { a: { c: 0, d: 1.5 }, z: [3, { b: true, y: null }], "\u00e9": "\u{1F600}" });
		assert.ok(lines[1].endsWith(`,"note":${canonical(record.note)}}`), "the note is written in canonical JSON, members in code-point order");
		assert.equal(record.digest, changeDigest({ writes: input.writes, note: record.note }, "a"), "the digest covers the note");
		assert.notEqual(record.digest, changeDigest({ writes: input.writes }, "a"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the note is part of the request a write identity names: the same writes with another note, or with none, are identity-reused, and the same note is recognised", () => {
	const { store, storage } = openLocal();
	const writes = [create(note("alpha"))];
	const first = store.change({ writes, note: { undo: [1, 2] } }, W("a", "c1"));
	assert.equal(first.outcome, "answered");
	assert.deepEqual(store.change({ writes, note: { undo: [1, 2] } }, W("a", "c1")), first);
	refusedWith(store.change({ writes, note: { undo: [2, 1] } }, W("a", "c1")), "identity-reused");
	refusedWith(store.change({ writes }, W("a", "c1")), "identity-reused");
	refusedWith(store.change({ writes, note: null }, W("a", "c1")), "identity-reused");
	assert.equal(storage.records().length, 1);
	const kept = store.change({ writes: [create(note("beta"))], note: null }, W("a", "c2"));
	assert.equal(kept.outcome, "answered");
	assert.equal(Object.hasOwn(storage.records()[1], "note"), true, "a null note is a note");
	assert.equal(storage.records()[1].note, null);
});

test("a note of exactly 524,288 bytes of canonical UTF-8 JSON and 16 levels lands; one byte more is note-too-large and one level more note-too-deep, refusing the whole change", () => {
	const { store, storage } = openLocal();
	const exact = "\u00e9".repeat(262_143);
	assert.equal(canonicalBytes(exact), 524_288, "measured in UTF-8 bytes, not UTF-16 code units");
	assert.equal(store.change({ writes: [create(note("alpha"))], note: exact }, W("a", "c1")).outcome, "answered");
	assert.equal(store.change({ writes: [create(note("beta"))], note: nest(16) }, W("a", "c2")).outcome, "answered");
	const before = storage.records();
	const large = refusedWith(store.change({ writes: [create(note("gamma"))], note: `${exact}x` }, W("a", "c3")), "note-too-large");
	assert.deepEqual(large.details, { bytes: 524_289, limit: 524_288 });
	const deep = refusedWith(store.change({ writes: [create(note("gamma"))], note: nest(17) }, W("a", "c4")), "note-too-deep");
	assert.deepEqual(deep.details, { depth: 17, limit: 16 });
	assert.deepEqual(storage.records(), before, "nothing was appended");
	assert.equal(store.read({ target: { kind: "note", name: "gamma" } }).answer.entity, null);
});

test("a note that is not plain JSON is refused as note-not-plain, running none of its code, observing any promise it holds, and appending nothing; it is decided before the write identity", async () => {
	const { store, storage } = openLocal();
	store.change({ writes: [create(note("alpha"))] }, W("a", "used"));
	const before = storage.records();
	let calls = 0;
	const getter = { a: 1 };
	Object.defineProperty(getter, "b", { get() { calls++; return 2; }, enumerable: true });
	const hidden = { a: 1 };
	Object.defineProperty(hidden, "b", { value: 2, enumerable: false });
	const cycle = { a: 1 };
	cycle.self = cycle;
	class Thing { constructor() { this.a = 1; } }
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const notes = [
			["a getter", getter],
			["a non-enumerable property", hidden],
			["a symbol key", { [Symbol("s")]: 1 }],
			["a class instance", new Thing()],
			["a map", new Map([["a", 1]])],
			["a date", new Date(0)],
			["a cycle", cycle],
			["undefined within", { a: undefined }],
			["NaN", Number.NaN],
			["a bigint", 1n],
			["a function", () => 1],
			["a proxy whose trap throws", new Proxy({}, { ownKeys() { throw new Error("trap"); } })],
			["a rejected promise", Promise.reject(new Error("held in a note"))],
			["a rejected promise within", { p: Promise.reject(new Error("held within a note")) }],
		];
		for (const [label, value] of notes) {
			const out = store.change({ writes: [create(note("beta"))], note: value }, W("a", `w-${label}`));
			assert.deepEqual(refusedWith(out, "note-not-plain").details, {}, label);
		}
		const input = { writes: [create(note("beta"))] };
		Object.defineProperty(input, "note", { get() { calls++; return 1; }, enumerable: true });
		refusedWith(store.change(input, W("a", "w-accessor")), "note-not-plain");
		refusedWith(store.change({ writes: [create(note("beta"))], note: getter }, W("a", "used")), "note-not-plain");
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.equal(calls, 0, "no getter ran");
	assert.deepEqual(unhandled, [], "every promise met was observed");
	assert.deepEqual(storage.records(), before, "nothing was appended");
});

test("changes carries each change's note once, on the first of that change's items, and a page counts the note's bytes", () => {
	const { store } = openLocal();
	store.change({ writes: [create(note("alpha")), create(note("beta")), create(note("gamma"))], note: { step: 1 } }, W("a", "c1"));
	store.change({ writes: [create(note("delta")), create(note("epsilon"))] }, W("a", "c2"));
	store.change({ writes: [create(note("zeta"))], note: "one write" }, W("a", "c3"));
	const items = store.changes({ since: 0 }).answer.changes;
	assert.deepEqual(items.map((item) => [item.id, Object.hasOwn(item, "note") ? item.note : "-"]), [
		["e1.1", { step: 1 }], ["e1.2", "-"], ["e1.3", "-"], ["e2.1", "-"], ["e2.2", "-"], ["e3.1", "one write"],
	]);
	const { note: carried, ...envelope } = items[0];
	assert.deepEqual(envelope, store.read({ target: { id: "e1.1" } }).answer.entity, "the item is the envelope, with the note beside its fields");
	assert.deepEqual(carried, { step: 1 });

	const paged = openLocal();
	const big = "n".repeat(300_000);
	paged.store.change({ writes: [create(note("one"))], note: big }, W("a", "p1"));
	paged.store.change({ writes: [create(note("two"))], note: big }, W("a", "p2"));
	const first = paged.store.changes({ since: 0 }).answer;
	assert.deepEqual([first.changes.length, first.next], [1, 1], "two notes of 300,000 bytes do not fit one page of 524,288");
	assert.equal(first.changes[0].note, big);
	const second = paged.store.changes({ since: 1 }).answer;
	assert.deepEqual([second.changes.length, second.next, second.changes[0].note === big], [1, null, true]);
});

test("follow carries a change's note once, on the first of that change's items in the answer, and not at all when the change gives the follow no item", () => {
	const { store } = openLocal();
	store.change({ writes: [create({ kind: "any", name: "x", tags: [], body: 1 }), create(note("gamma", ["t:a"])), create(note("delta", ["t:a"]))], note: { n: 1 } }, W("a", "c1"));
	store.change({ writes: [create({ kind: "any", name: "y", tags: [], body: 2 })], note: { n: 2 } }, W("a", "c2"));
	store.change({ writes: [create(note("eta", ["t:a"]))], note: { n: 3 } }, W("a", "c3"));
	const notes = store.follow({ kind: "note", tags: ["t:a"], since: 0 }).answer;
	assert.deepEqual(notes.changes.map((item) => [item.id, Object.hasOwn(item, "note") ? item.note : "-"]), [["e1.2", { n: 1 }], ["e1.3", "-"], ["e3.1", { n: 3 }]]);
	assert.equal(notes.through, 3);
	const any = store.follow({ kind: "any", since: 0 }).answer;
	assert.deepEqual(any.changes.map((item) => [item.id, item.event, item.note]), [["e1.1", "entering", { n: 1 }], ["e2.1", "entering", { n: 2 }]]);
});

test("a note is served again after the store opens again, and forgotten with its change once the history bound passes it, while an archive keeps the evicted record whole", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-note-"));
	try {
		const file = path.join(dir, "changes.log");
		const archiveFile = path.join(dir, "archive.log");
		let now = T0;
		const ports = [];
		const open = () => {
			ports.push(createFileStoragePort(file, { archiveFile }));
			const opening = openEntityStore({ storage: ports.at(-1), clock: { now: () => now }, historyMs: 1000, maxEntityBytes: 65_536, kinds: KINDS });
			assert.equal(opening.opened, true, JSON.stringify(opening.refusal));
			return opening.store;
		};
		let store = open();
		store.change({ writes: [create(note("alpha")), create(note("beta"))], note: { undo: "first" } }, W("a", "c1"));
		store = open();
		assert.deepEqual(store.changes({ since: 0 }).answer.changes[0].note, { undo: "first" }, "served after replay");
		now = T0 + 500;
		store.change({ writes: [create(note("gamma"))], note: { undo: "second" } }, W("a", "c2"));
		now = T0 + 1000;
		store.create(note("delta"), W("a", "s1"));
		assert.equal(store.changes({ since: 0 }).refusal.code, "position-not-held");
		assert.deepEqual(store.changes({ since: 1 }).answer.changes.map((item) => [item.id, item.note ?? "-"]), [["e2.1", { undo: "second" }], ["e3.1", "-"]]);
		const active = fs.readFileSync(file, "utf8");
		assert.equal(active.includes("first"), false, "the forgotten change's note is gone from the active log");
		assert.ok(active.includes("second"), "a held change's note is kept");
		const archived = fs.readFileSync(archiveFile, "utf8").trimEnd().split("\n");
		assert.equal(archived.length, 2);
		assert.deepEqual(JSON.parse(archived[1]).note, { undo: "first" }, "the archive keeps the evicted record with its note");
		store = open();
		assert.deepEqual(store.changes({ since: 1 }).answer.changes[0].note, { undo: "second" }, "the store opens again over its archive");
		now = T0 + 2000;
		store.create(note("epsilon"), W("a", "s2"));
		assert.equal(fs.readFileSync(file, "utf8").includes("second"), false);
		const memory = openLocal({ historyMs: 1000 });
		memory.store.change({ writes: [create(note("alpha"))], note: { undo: "kept" } }, W("a", "m1"));
		memory.clock.set(T0 + 1000);
		memory.store.create(note("beta"), W("a", "m2"));
		assert.equal(JSON.stringify(memory.storage.records()).includes("kept"), false, "forgotten from memory storage too");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a change log whose change record holds a note beyond either bound stops the store opening, naming its line; one at the bounds opens", () => {
	const stamp = { position: 1, at, writer: "fixture" };
	const entity = { id: "e1.1", kind: "note", name: "first", tags: [], body: { pointer: "https://e.x/", summary: "s" }, revision: 1, created: stamp, changed: stamp };
	const opening = (noteValue) => {
		const storage = createMemoryStoragePort();
		storage.append({ type: "change", position: 1, at, writer: "fixture", writeId: "w", digest: "0".repeat(64), answer: { position: 1, writes: [{ entity }] }, writes: [{ operation: "create", id: "e1.1", entity }], note: noteValue });
		return openEntityStore({ storage, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
	};
	assert.equal(opening(nest(16)).opened, true);
	assert.equal(opening("x".repeat(524_286)).opened, true);
	for (const [label, value] of [["17 levels", nest(17)], ["524,289 bytes", "x".repeat(524_287)]]) {
		const bad = opening(value);
		assert.equal(bad.opened, false, label);
		assert.equal(bad.refusal.code, "log-corrupt", label);
		assert.equal(bad.refusal.details.line, 2, label);
	}
});
