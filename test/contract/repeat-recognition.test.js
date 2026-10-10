// repeat-recognition - a write carries an identity its writer supplies; a repeat under it takes no second
// position and returns the first answer, while the change it repeats is within the history bound (zorg's
// target, EM7 and EM8; E4).
//
// Runs the shared suite's cases for this row locally - including the repeat one millisecond inside the
// bound and exactly at it, and EM8's schedule across a restart - then the cases only a local store shows:
// the digest EM7 defines, computed here with an independent SHA-256, what each change record keeps, and
// the check entity-api's host half asks before its policy rules (EM13, step 2). EM8's schedule also runs on
// the file port in a child process that is really killed, and the store is reopened with the clock set back.
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

test("local: an input that does not fit its shape - one carrying a writer included - throws a TypeError naming the field before the identity is checked, and appends nothing", () => {
	const { store, storage, clock } = openLocal({ historyMs: 1000 });
	const write = { writer: "alice", writeId: "w1" };
	const first = store.create(note("alpha"), write);
	clock.set(T0 + 500);
	const records = storage.records();
	const withWriter = { ...note("alpha"), writer: "alice" };
	const namesWriter = (e) => e instanceof TypeError && e.message.includes("/writer");
	assert.throws(() => store.create(withWriter, write), namesWriter, "a retained identity whose repeat carries a writer: thrown, not recognised");
	assert.throws(() => store.create({ ...note("beta"), writer: "alice" }, write), namesWriter, "a retained identity with another input carrying a writer: thrown, not identity-reused");
	assert.throws(() => store.checkRepeat("create", withWriter, write), namesWriter, "the repeat check throws the same");
	assert.throws(() => store.update({ target: { id: "e1.1" }, name: 7 }, write), (e) => e instanceof TypeError && e.message.includes("/name"), "a misfit of another field, under a retained identity");
	assert.deepEqual(storage.records(), records, "nothing was appended, not even the time record a decision about retention would need");
	assert.equal(store.historyBound().answer.position, 1);
	assert.deepEqual(store.create(note("alpha"), write), first, "an input that fits is checked for its identity first: recognised");
	const reused = store.create({ ...note("beta"), name: "Not A Name" }, write);
	assert.deepEqual([reused.outcome, reused.refusal.code], ["refused", "identity-reused"], "and refused as identity-reused before its name is judged");
});

test("local: a fitting body nesting 4000 arrays under a retained identity is refused as identity-reused, which comes before entity-too-deep, and changes nothing", () => {
	const { store, storage } = openLocal({ historyMs: 1000 });
	const write = { writer: "alice", writeId: "w1" };
	const input = { kind: "any", name: "a", tags: [], body: 0 };
	const first = store.create(input, write);
	assert.equal(first.outcome, "answered");
	const records = storage.records();
	const deep = { ...input, body: JSON.parse(`${"[".repeat(4000)}0${"]".repeat(4000)}`) };
	for (const [outcome, how] of [[store.create(deep, write), "a create"], [store.update({ target: { id: "e1.1" }, body: deep.body }, write), "an update"]]) {
		assert.equal(outcome.outcome, "refused", how);
		assert.deepEqual(Object.keys(outcome.refusal).sort(), ["code", "details", "fix", "part", "what", "why"], how);
		assert.deepEqual([outcome.refusal.part, outcome.refusal.code, outcome.refusal.details], ["entity-store", "identity-reused", { writeId: "w1" }], how);
	}
	const check = store.checkRepeat("create", deep, write);
	assert.deepEqual([check.repeat, check.refusal.details], ["identity-reused", { writeId: "w1" }], "the repeat check says the same");
	assert.deepEqual(storage.records(), records, "nothing was appended: the store's time is the logged time, so the decision needed no time record");
	assert.equal(store.historyBound().answer.position, 1, "no position was taken");
	assert.deepEqual(store.read({ target: { id: "e1.1" } }).answer.entity, first.answer.entity, "the entity is unchanged");
	assert.deepEqual(store.create(input, write), first, "the first input is still recognised");
});

test("file port, process killed: changes at 1000 and 1900 with a bound of 1000, a repeat of the second at 2000, the process killed, the clock set back to 1900 and the store reopened, and a repeat of the first runs afresh", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-schedule-"));
	try {
		const file = path.join(dir, "changes.log");
		const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "support", "schedule-child.js");
		const [first, second, repeat] = await runUntilReadyThenKill(child, [file, "repeat"], path.join(dir, "acks"));
		assert.deepEqual([first.outcome.answer.position, second.outcome.answer.position], [1, 2], "the changes at 1000 and 1900 were acknowledged");
		assert.equal(second.outcome.answer.entity.changed.at, "1970-01-01T00:00:01.900Z");
		assert.deepEqual(repeat.outcome, second.outcome, "the repeat of the second at 2000 was recognised before the kill");
		const timeRecords = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"type":"time"'));
		assert.deepEqual(timeRecords.map((l) => JSON.parse(l).at), ["1970-01-01T00:00:02.000Z"], "the decision at 2000 reached the change log before the kill");

		const { store, storage } = openLocal({ storage: createFileStoragePort(file), time: 1900, historyMs: SCHEDULE.historyMs });
		try {
			const again = store[SCHEDULE.first.op](SCHEDULE.first.input, SCHEDULE.first.write);
			assert.deepEqual([again.outcome, again.refusal?.code], ["refused", "name-taken"], "the repeat of the first runs afresh: the store's time is 2000, not the clock's 1900, and the create meets its own entity's name");
			assert.deepEqual(store[SCHEDULE.second.op](SCHEDULE.second.input, SCHEDULE.second.write), second.outcome, "the second is still recognised at 2000");
			assert.equal(store.historyBound().answer.position, 2, "nothing took a position");
		} finally {
			storage.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
