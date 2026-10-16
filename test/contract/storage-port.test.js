// storage-port - persistence is through a storage port the application supplies, in memory or durable
// (zorg's target, EM15; D24; E10, and the store-level part of E4 after recovery). Runs locally only.
//
// Both ports are given the same scenario - a create, a rename, a delete, a name taken again after its
// delete, a repeated delete and a time record - and a store recovered from what each kept must hold every
// entry, revision, position, writer and repeat record. The file port is also killed for real: a child
// process is sent SIGKILL just after a change was acknowledged, and another just after it wrote the memory
// port's change of two writes to a change log file, which is then recovered whole and, cut short, with
// neither write. Children acknowledge through a file, not a pipe (../support/child-process.js). The change
// log's format, its truncation and the faults that stop a store opening are in
// ../support/storage-port-file-cases.js, registered here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { runUntilReadyThenKill } from "../support/child-process.js";
import { createLocalHarness } from "../support/local-harness.js";
import { KINDS, openLocal } from "../support/local-store.js";
import { appendTwoWriteChange, checkRecovered, PAIR, runScenario, snapshot, STEPS, T0 } from "../support/recovery-scenario.js";
import "../support/storage-port-file-cases.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-port-"));

// The suite's rows whose cases restart a store, run again over the file port, so repeats and the history
// bound are decided the same after recovery from a change log on disk.
registerEntityStoreSuite((name, run) => test(`file port: ${name}`, run), createLocalHarness({ storage: "file" }), ["positioned-entity-write", "repeat-recognition", "stated-history-bound"]);

test("memory port: a store opened again on the same port recovers every entity, revision, position, writer and repeat record", () => {
	const storage = createMemoryStoragePort();
	const first = openLocal({ storage });
	const done = runScenario(first.store, first.clock);
	const before = snapshot(first.store);
	assert.ok(storage.records().some((r) => r.type === "time"), "the scenario left a time record");
	const second = openLocal({ storage });
	checkRecovered(assert, second.store, second.clock, done, before);
});

test("file port: a store opened on the same change log recovers every entity, revision, position, writer and repeat record", () => {
	const dir = tempDir();
	const file = path.join(dir, "changes.log");
	const first = openLocal({ storage: createFileStoragePort(file) });
	const done = runScenario(first.store, first.clock);
	const before = snapshot(first.store);
	const second = openLocal({ storage: createFileStoragePort(file) });
	checkRecovered(assert, second.store, second.clock, done, before);
	fs.rmSync(dir, { recursive: true });
});

test("the memory port keeps the same records as the file port's change log", () => {
	const dir = tempDir();
	const file = path.join(dir, "changes.log");
	const memory = createMemoryStoragePort();
	const m = openLocal({ storage: memory });
	runScenario(m.store, m.clock);
	const f = openLocal({ storage: createFileStoragePort(file) });
	runScenario(f.store, f.clock);
	const lines = fs.readFileSync(file, "utf8").split("\n");
	assert.equal(lines.pop(), "", "the log ends with a newline");
	assert.equal(lines.shift(), '{"log":"entity-store","version":1}');
	assert.deepEqual(lines.map((l) => JSON.parse(l)), memory.records());
	fs.rmSync(dir, { recursive: true });
});

test("a change of two writes written by the memory port's test fixture is recovered, with every other record of the scenario", async () => {
	const storage = createMemoryStoragePort();
	const first = openLocal({ storage });
	const done = runScenario(first.store, first.clock);
	const { position: p, one } = await appendTwoWriteChange(storage, first.store);
	const second = openLocal({ storage });
	const after = snapshot(second.store);
	assert.equal(after.position, p, "the two writes took one position");
	assert.deepEqual(after.kinds.note.map((e) => e.name), ["alpha-renamed", "pair-one", "pair-two"]);
	assert.equal(second.store.read({ target: { kind: "note", name: "beta" } }).answer.entity, null, "the second write's rename freed the old name");
	second.clock.set(first.clock.now() + 100);
	assert.deepEqual(second.store[PAIR.op](PAIR.input, PAIR.write), { outcome: "answered", answer: { position: p, entity: one } }, "its repeat is recognised, answering the create");
	const reuse = second.store.create({ kind: "note", name: "x", tags: [], body: { pointer: "https://e.x/", summary: "x" } }, PAIR.write);
	assert.deepEqual([reuse.outcome, reuse.refusal?.code], ["refused", "identity-reused"], "its write identity is retained, naming the recovered change");
	assert.equal(done.length, STEPS.length);
});

/** Runs the kill child until it has acknowledged every step it was given, then kills it with SIGKILL. */
function runAndKill(file, count) {
	return runUntilReadyThenKill(path.join(here, "..", "support", "kill-child.js"), [file, String(count)], `${file}.acks`);
}

test("file port: after the process is killed just after a change was acknowledged, every acknowledged change is recovered and the next takes the next position", async () => {
	const dir = tempDir();
	const file = path.join(dir, "changes.log");
	const acks = await runAndKill(file, STEPS.length);
	assert.equal(acks.length, STEPS.length);
	const done = STEPS.map((step, i) => ({ ...step, answer: acks[i].answer }));
	const reference = openLocal({ storage: createMemoryStoragePort() });
	runScenario(reference.store, reference.clock);
	const recovered = openLocal({ storage: createFileStoragePort(file) });
	checkRecovered(assert, recovered.store, recovered.clock, done, snapshot(reference.store));
	fs.rmSync(dir, { recursive: true });
});

test("file port: killed part-way and ending in an incomplete record, the log recovers by discarding it, and the store continues from the last acknowledged change", async () => {
	const dir = tempDir();
	const file = path.join(dir, "changes.log");
	const acks = await runAndKill(file, 3);
	const whole = fs.readFileSync(file);
	fs.appendFileSync(file, '{"type":"change","position":4,"at":"2026-10-09T10:00:00.030Z","wri');
	const recovered = openLocal({ storage: createFileStoragePort(file), kinds: KINDS });
	assert.deepEqual(fs.readFileSync(file), whole, "the file is cut back to the last whole record");
	assert.equal(recovered.store.historyBound().answer.position, acks.at(-1).answer.position);
	assert.equal(recovered.store.read({ target: { id: "e1.1" } }).answer.entity.name, "alpha-renamed");
	const next = runScenario(recovered.store, recovered.clock, STEPS.slice(3, 4));
	assert.equal(next[0].answer.position, 4, "the next change takes position 4");
	fs.rmSync(dir, { recursive: true });
});

/** Runs the two-write child until its store is open on the change log it wrote, then kills it with SIGKILL. */
async function writeTwoWriteLogAndKill(dir) {
	const file = path.join(dir, "changes.log");
	const [written] = await runUntilReadyThenKill(path.join(here, "..", "support", "two-write-child.js"), [file], path.join(dir, "acks"));
	return { file, written };
}

test("file port: the memory port's change of two writes, written to a change log file, is recovered after the process is killed - both entities at its one position, its repeat recognised", async () => {
	const dir = tempDir();
	try {
		const { file, written } = await writeTwoWriteLogAndKill(dir);
		const { position: p, one, renamed } = written.pair;
		assert.equal(written.snapshot.position, p, "the child's store opened on the file at the change's position");
		const lines = fs.readFileSync(file, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
		assert.deepEqual(lines.at(-1), written.pair.record, "the change of two writes is the change log's last record, as written");
		const recovered = openLocal({ storage: createFileStoragePort(file) });
		try {
			const after = snapshot(recovered.store);
			assert.deepEqual(after, written.snapshot, "everything the child's store held is recovered");
			assert.equal(after.position, p, "the two writes took one position");
			assert.deepEqual(recovered.store.read({ target: { id: one.id } }).answer, { position: p, entity: one }, "the first write's entity, at the change's position");
			assert.deepEqual(recovered.store.read({ target: { id: renamed.id } }).answer, { position: p, entity: renamed }, "the second write's entity, at the same position");
			assert.equal(recovered.store.read({ target: { kind: "note", name: "beta" } }).answer.entity, null, "the second write's rename freed the old name");
			const asOfBefore = recovered.store.find({ kind: "note", asOf: p - 1 }).answer.entries.map((e) => e.name);
			assert.deepEqual(asOfBefore, ["alpha-renamed", "beta"], "as of the position before, neither write is seen");
			recovered.clock.set(T0 + 100);
			assert.deepEqual(recovered.store[PAIR.op](PAIR.input, PAIR.write), { outcome: "answered", answer: { position: p, entity: one } }, "its repeat is recognised, answering the create, and takes no position");
			for (const { writeId, answer } of written.done) {
				const step = STEPS.find((s) => s.write.writeId === writeId);
				assert.deepEqual(recovered.store[step.op](step.input, step.write), { outcome: "answered", answer }, `the scenario's ${writeId} is recognised too`);
			}
			assert.equal(recovered.store.historyBound().answer.position, p, "no repeat took a position");
			const next = recovered.store.create({ kind: "note", name: "after", tags: [], body: { pointer: "https://e.x/a", summary: "a" } }, { writer: "erin", writeId: "next" });
			assert.equal(next.answer.entity.id, `e${p + 1}.1`, "the next change takes the next position");
		} finally {
			recovered.storage.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("file port: the same change of two writes cut short recovers with neither write", async () => {
	const dir = tempDir();
	try {
		const { file, written } = await writeTwoWriteLogAndKill(dir);
		const { position: p, one, renamed } = written.pair;
		const whole = fs.readFileSync(file);
		const lastLine = Buffer.from(`${JSON.stringify(written.pair.record)}\n`, "utf8");
		const before = whole.subarray(0, whole.length - lastLine.length);
		assert.ok(whole.subarray(before.length).equals(lastLine), "the change of two writes is the last line");
		const secondWrite = lastLine.indexOf('"pair-two"');
		for (const keep of [1, Math.floor(lastLine.length / 2), secondWrite, secondWrite + 12, lastLine.length - 2, lastLine.length - 1]) {
			fs.writeFileSync(file, Buffer.concat([before, lastLine.subarray(0, keep)]));
			const recovered = openLocal({ storage: createFileStoragePort(file) });
			try {
				const what = `the record cut to ${keep} of ${lastLine.length} bytes`;
				assert.ok(fs.readFileSync(file).equals(before), `${what}: the file is cut back to the record before it`);
				assert.equal(recovered.store.historyBound().answer.position, p - 1, `${what}: the position is the one before it`);
				assert.equal(recovered.store.read({ target: { id: one.id } }).answer.entity, null, `${what}: the first write is not recovered`);
				assert.equal(recovered.store.read({ target: { kind: "note", name: "pair-two" } }).answer.entity, null, `${what}: the second write is not recovered`);
				assert.equal(recovered.store.read({ target: { id: renamed.id } }).answer.entity.name, "beta", `${what}: the entity the second write renamed keeps its name`);
				assert.deepEqual(recovered.store.checkRepeat(PAIR.op, PAIR.input, PAIR.write), { repeat: "none" }, `${what}: its write identity is not held`);
			} finally {
				recovered.storage.close();
			}
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("D2-E1, D54, D55: src/json-value.ts is removed, and what a storage port's load returns or throws is read as plain data through shape-check - any non-plain object, getter, inherited or symbol property, or nested rejected Promise is refused as log-corrupt with zero getter calls and zero unhandled rejections", async () => {
	assert.equal(fs.existsSync(path.join(here, "..", "..", "src", "json-value.ts")), false, "src/json-value.ts does not exist");
	let getters = 0;
	const sym = Symbol("s");
	const inherited = Object.create({ ok: true, records: [] });
	const withSymbol = { ok: true, records: [], [sym]: 1 };
	const nonEnumerable = { ok: true, records: [] };
	Object.defineProperty(nonEnumerable, "hidden", { value: 1, enumerable: false });
	const classInstance = new (class Load { ok = true; records = []; })();
	const cases = [
		() => {
			const err = new Error("load failed");
			err.nested = Promise.reject(new Error("thrown nested rejection"));
			throw err;
		},
		() => Promise.reject(new Error("returned promise")),
		() => ({ get ok() { getters++; return true; }, records: [] }),
		() => ({ ok: true, get records() { getters++; return []; } }),
		() => ({ ok: true, records: [{ line: 2, get record() { getters++; return { type: "time", at: "2026-10-09T10:00:00.000Z" }; } }] }),
		() => ({ ok: true, records: [{ line: 2, record: { type: "time", get at() { getters++; return "2026-10-09T10:00:00.000Z"; } } }] }),
		() => ({ ok: true, records: [{ line: 2, record: { type: "time", at: "2026-10-09T10:00:00.000Z" }, extra: Promise.reject(new Error("record entry rejection")) }] }),
		() => ({ ok: false, fault: { code: "log-corrupt", line: 1, get message() { getters++; return "x"; }, p: Promise.reject(new Error("fault rejection")) } }),
		() => inherited,
		() => withSymbol,
		() => nonEnumerable,
		() => classInstance,
		() => new Proxy({ ok: true, records: [] }, { ownKeys() { throw Object.assign(new Error("trap"), { p: Promise.reject(new Error("trap rejection")) }); } }),
	];
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		for (const [i, load] of cases.entries()) {
			const opening = openEntityStore({
				storage: { load, append() {} },
				clock: { now: () => T0 },
				historyMs: 60_000,
				maxEntityBytes: 65_536,
				kinds: KINDS,
			});
			assert.equal(opening.opened, false, `case ${i} is refused`);
			assert.equal(opening.refusal.code, "log-corrupt", `case ${i} code`);
		}
		await new Promise((resolve) => setTimeout(resolve, 30));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.equal(getters, 0, "no getter on a loaded value was invoked");
	assert.deepEqual(unhandled, [], "every rejected promise was observed");
});
