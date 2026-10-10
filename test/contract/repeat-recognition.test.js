// repeat-recognition - a write carries an identity its writer supplies; a repeat under it takes no second
// position and returns the first answer, while the change it repeats is within the history bound (zorg's
// target, EM7 and EM8; E4).
//
// Runs the shared suite's cases for this row locally - including the repeat one millisecond inside the
// bound and exactly at it, and EM8's schedule across a restart - then the cases only a local store shows:
// the digest EM7 defines, computed here with an independent SHA-256, what each change record keeps, and
// the check entity-api's host half asks before its policy rules (EM13, step 2).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness } from "../support/local-harness.js";
import { note, openLocal, T0 } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["repeat-recognition"]);

const byCodePoint = (a, b) => {
	const x = Array.from(a, (c) => c.codePointAt(0));
	const y = Array.from(b, (c) => c.codePointAt(0));
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
	return x.length - y.length;
};
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
	: v !== null && typeof v === "object" ? `{${Object.keys(v).sort(byCodePoint).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
	: JSON.stringify(v);
const digest = (operation, input, writer) => crypto.createHash("sha256").update(Buffer.from(canonical({ input, operation, writer }), "utf8")).digest("hex");

test("local: each change keeps its write identity, its digest - SHA-256 of the canonical JSON of input, operation and writer - and its answer", () => {
	const { store, storage } = openLocal();
	const inputs = [
		["create", { kind: "note", name: "cafe-x", tags: ["b:b", "a:a"], body: { summary: "s \u{1F600} \u00e9", pointer: "https://e.x/" } }],
		["update", { target: { kind: "note", name: "cafe-x" }, body: { summary: "two" }, expectedRevision: 1 }],
		["delete", { target: { id: "e1.1" } }],
	];
	const answers = inputs.map(([op, input], i) => store[op](input, { writer: `writer-${i}`, writeId: `id-${i}` }));
	const changes = storage.records().filter((r) => r.type === "change");
	for (const [i, [op, input]] of inputs.entries()) {
		assert.equal(changes[i].writeId, `id-${i}`);
		assert.match(changes[i].digest, /^[0-9a-f]{64}$/);
		assert.equal(changes[i].digest, digest(op, input, `writer-${i}`), `the digest of the ${op}`);
		assert.deepEqual(changes[i].answer, answers[i].answer, `the answer of the ${op}`);
	}
});

test("local: the repeat check says none, recognised with the first answer, or identity-reused, and makes no change", () => {
	const { store, storage, clock } = openLocal({ historyMs: 1000 });
	const write = { writer: "alice", writeId: "w1" };
	assert.deepEqual(store.checkRepeat("create", note("alpha"), write), { repeat: "none" }, "an identity never used");
	const first = store.create(note("alpha"), write);
	const records = storage.records().length;
	assert.deepEqual(store.checkRepeat("create", note("alpha"), write), { repeat: "recognised", answer: first.answer });
	const reused = store.checkRepeat("create", note("beta"), write);
	assert.equal(reused.repeat, "identity-reused");
	assert.deepEqual(reused.refusal.details, { writeId: "w1" });
	assert.equal(store.checkRepeat("create", note("alpha"), { writer: "bob", writeId: "w1" }).repeat, "identity-reused", "another writer");
	assert.equal(storage.records().length, records, "no change was made");
	clock.set(T0 + 1000);
	assert.deepEqual(store.checkRepeat("create", note("alpha"), write), { repeat: "none" }, "outside the bound the identity is not retained");
	assert.equal(store.historyBound().answer.position, 1, "no check took a position");
});

test("local: a repeat's answer is a copy, so changing it changes neither the store nor a later repeat", () => {
	const { store } = openLocal();
	const write = { writer: "alice", writeId: "w1" };
	const first = store.create(note("alpha"), write);
	const repeat = store.create(note("alpha"), write);
	repeat.answer.entity.name = "mangled";
	assert.deepEqual(store.create(note("alpha"), write), first);
});
