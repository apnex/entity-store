// storage-port - persistence is through a storage port the application supplies, in memory or durable
// (zorg's target, EM15; D24; E10, and the store-level part of E4 after recovery). Runs locally only.
//
// Both ports are given the same scenario - a create, a rename, a delete, a name taken again after its
// delete, a repeated delete and a time record - and a store recovered from what each kept must hold every
// entry, revision, position, writer and repeat record. The file port is also killed for real: a child
// process is sent SIGKILL just after a change was acknowledged. The change log's format, its truncation and
// the faults that stop a store opening are in ../support/storage-port-file-cases.js, registered here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMemoryStoragePort } from "@apnex/entity-store";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { createLocalHarness } from "../support/local-harness.js";
import { KINDS, openLocal } from "../support/local-store.js";
import { checkRecovered, runScenario, snapshot, STEPS, T0 } from "../support/recovery-scenario.js";
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

test("a change of two writes written by the memory port's test fixture is recovered, with every other record of the scenario", () => {
	const storage = createMemoryStoragePort();
	const first = openLocal({ storage });
	const done = runScenario(first.store, first.clock);
	const p = first.store.historyBound().answer.position + 1;
	const at = new Date(T0 + 80).toISOString();
	const stamp = { position: p, at, writer: "fixture" };
	const one = { id: `e${p}.1`, kind: "note", name: "pair-one", tags: [], body: { pointer: "https://e.x/1", summary: "one" }, revision: 1, created: stamp, changed: stamp };
	const renamed = { ...snapshot(first.store).kinds.note.find((e) => e.name === "beta"), name: "pair-two", revision: 2, changed: stamp };
	storage.append({ type: "change", position: p, at, writer: "fixture", writeId: "pair", digest: "f".repeat(64), answer: { position: p, entity: one },
		writes: [{ operation: "create", id: one.id, entity: one }, { operation: "update", id: renamed.id, entity: renamed }] });
	const second = openLocal({ storage });
	const after = snapshot(second.store);
	assert.equal(after.position, p, "the two writes took one position");
	assert.deepEqual(after.kinds.note.map((e) => e.name), ["alpha-renamed", "pair-one", "pair-two"]);
	assert.equal(second.store.read({ target: { kind: "note", name: "beta" } }).answer.entity, null, "the second write's rename freed the old name");
	const reuse = second.store.create({ kind: "note", name: "x", tags: [], body: { pointer: "https://e.x/", summary: "x" } }, { writer: "f", writeId: "pair" });
	assert.deepEqual([reuse.outcome, reuse.refusal?.code], ["refused", "identity-reused"], "its write identity is retained, naming the recovered change");
	assert.equal(done.length, STEPS.length);
});

/** Runs the child until it has acknowledged every step it was given, then kills it with SIGKILL. */
function runAndKill(file, count) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(here, "..", "support", "kill-child.js"), file, String(count)], { stdio: ["ignore", "pipe", "inherit"] });
		const acks = [];
		let buffered = "";
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			let nl;
			while ((nl = buffered.indexOf("\n")) >= 0) {
				const message = JSON.parse(buffered.slice(0, nl));
				buffered = buffered.slice(nl + 1);
				if (message.error) reject(new Error(JSON.stringify(message.error)));
				else if (message.ack) acks.push(message);
				else if (message.ready) child.kill("SIGKILL");
			}
		});
		child.on("exit", (code, signal) => signal === "SIGKILL" ? resolve(acks) : reject(new Error(`the child exited ${code} ${signal}`)));
	});
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
