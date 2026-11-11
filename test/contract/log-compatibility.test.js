// log-compatibility - the change log of 0.1.0 reads unchanged (D4, D5; zorg's answer 2 to draw's H31-3): a log and
// archive written by 0.1.0 open under this code without a byte touched and with every digest the same, and the same
// writes made through the single operations write a log and archive byte-identical to 0.1.0's.
//
// 0.1.0 is the release file itself, installed as the development dependency @apnex/entity-store-0.1.0 from the
// release's address and pinned in the lockfile by the integrity its SHA-512 asset states, so the comparison is with
// what consumers run, not with a rebuild of its source.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as current from "@apnex/entity-store";
import * as currentFile from "@apnex/entity-store/file-storage";
import * as released from "@apnex/entity-store-0.1.0";
import * as releasedFile from "@apnex/entity-store-0.1.0/file-storage";
import { KINDS, note, T0 } from "../support/local-store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_URL = "https://github.com/apnex/entity-store/releases/download/v0.1.0/apnex-entity-store-0.1.0.tgz";
// The SHA-512 asset of the v0.1.0 release, apnex-entity-store-0.1.0.tgz.sha512, in npm's integrity form.
const RELEASE_INTEGRITY = "sha512-2Xf4h9Y+4IU2vI6t9cjY9RJST4LKt4mNByz51YINY09wuM3q2L79dg0ZJCvjF/8ZTdpwCsJQ4m5IjX7FDI1rGw==";
const HISTORY_MS = 10_000;
const sha = (bytes) => (bytes === null ? null : crypto.createHash("sha256").update(bytes).digest("hex"));
const W = (writer, writeId) => ({ writer, writeId });

/** A store over a change log and an archive in `dir`, made by one version's code, with a clock the steps set. */
function session(api, fileApi, dir) {
	let now = T0;
	let port;
	let store;
	const file = path.join(dir, "changes.log");
	const archiveFile = path.join(dir, "archive.log");
	const files = () => ({ log: fs.readFileSync(file), archive: fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile) : null });
	const open = () => {
		port?.close();
		port = fileApi.createFileStoragePort(file, { archiveFile });
		const opening = api.openEntityStore({ storage: port, clock: { now: () => now }, historyMs: HISTORY_MS, maxEntityBytes: 65_536, kinds: KINDS });
		store = opening.opened ? opening.store : undefined;
		return opening.opened ? { opened: true } : opening;
	};
	return { open, files, set: (ms) => { now = ms; }, get store() { return store; }, close: () => port?.close() };
}

/** Runs steps against a session, giving a transcript of every outcome and the digest of both files after each. */
function run(s, steps) {
	return steps.map(([label, step]) => {
		const outcome = step(s);
		const { log, archive } = s.files();
		return { label, outcome: outcome === undefined ? null : JSON.parse(JSON.stringify(outcome)), log: sha(log), archive: sha(archive) };
	});
}

const PHASE_ONE = [
	["open", (s) => s.open()],
	["create alpha", (s) => s.store.create(note("alpha", ["t:a"]), W("alice", "w1"))],
	["create beta", (s) => s.store.create(note("beta"), W("alice", "w2"))],
	["create doc", (s) => s.store.create({ kind: "any", name: "doc", tags: ["z:z", "a:a"], body: { nested: { a: 1 }, list: [1, "\u00e9", null] } }, W("bob", "w3"))],
	["update alpha by revision", (s) => s.store.update({ target: { id: "e1.1" }, expectedRevision: 1, body: { summary: "two" } }, W("bob", "w4"))],
	["rename beta", (s) => s.store.update({ target: { kind: "note", name: "beta" }, name: "beta-two", tags: ["k:v"] }, W("alice", "w5"))],
	["repeat of w4", (s) => s.store.update({ target: { id: "e1.1" }, expectedRevision: 1, body: { summary: "two" } }, W("bob", "w4"))],
	["w4 reused", (s) => s.store.update({ target: { id: "e1.1" }, body: { summary: "three" } }, W("bob", "w4"))],
	["name-taken", (s) => s.store.create(note("alpha"), W("alice", "w6"))],
	["misfit", (s) => s.store.create({ kind: "note", name: "bad", tags: [], body: {} }, W("alice", "w7"))],
	["revision-moved", (s) => s.store.update({ target: { id: "e1.1" }, expectedRevision: 1, tags: [] }, W("alice", "w8"))],
	["not-found", (s) => s.store.delete({ target: { id: "e9.9" } }, W("alice", "w9"))],
	["later, delete doc", (s) => { s.set(T0 + 1000); return s.store.delete({ target: { kind: "any", name: "doc" } }, W("bob", "w10")); }],
	["find", (s) => s.store.find({ kind: "note" })],
	["changes", (s) => s.store.changes({ since: 0 })],
	["follow", (s) => s.store.follow({ kind: "note", tags: ["t:a"], since: 0 })],
	["later, read and changes", (s) => { s.set(T0 + 3000); return [s.store.read({ target: { id: "e1.1" } }), s.store.changes({ since: 2 })]; }],
	["create gamma", (s) => s.store.create(note("gamma"), W("carol", "w11"))],
	["reopen", (s) => s.open()],
	["past the bound, create delta", (s) => { s.set(T0 + 12_000); return s.store.create(note("delta"), W("carol", "w12")); }],
	["changes behind the bound", (s) => s.store.changes({ since: 0 })],
	["changes after the base", (s) => s.store.changes({ since: 6 })],
];

const PHASE_TWO = [
	["repeat of w11, written before", (s) => s.store.create(note("gamma"), W("carol", "w11"))],
	["repeat of w12, written before", (s) => s.store.create(note("delta"), W("carol", "w12"))],
	["follow after the base", (s) => s.store.follow({ kind: "note", since: 6 })],
	["reopen", (s) => s.open()],
	["far later, update gamma", (s) => { s.set(T0 + 30_000); return s.store.update({ target: { kind: "note", name: "gamma" }, tags: ["t:b"] }, W("carol", "w13")); }],
	["repeat of w13", (s) => s.store.update({ target: { kind: "note", name: "gamma" }, tags: ["t:b"] }, W("carol", "w13"))],
	["repeat check of w12, now outside the bound", (s) => s.store.checkRepeat("create", note("delta"), W("carol", "w12"))],
	["reopen again", (s) => s.open()],
	["history bound", (s) => s.store.historyBound()],
	["delete alpha", (s) => s.store.delete({ target: { id: "e1.1" }, expectedRevision: 2 }, W("alice", "w14"))],
];

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `entity-store-compat-${label}-`));

test("the 0.1.0 compared against is the release file: installed from the release's address, with the integrity its SHA-512 asset states", () => {
	const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
	const entry = lock.packages["node_modules/@apnex/entity-store-0.1.0"];
	assert.equal(entry.resolved, RELEASE_URL);
	assert.equal(entry.integrity, RELEASE_INTEGRITY);
	const installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "@apnex", "entity-store-0.1.0", "package.json"), "utf8"));
	assert.deepEqual([installed.name, installed.version], ["@apnex/entity-store", "0.1.0"]);
	assert.notEqual(released.openEntityStore, current.openEntityStore, "two distinct codes are compared");
	assert.equal(typeof released.openEntityStore({ storage: released.createMemoryStoragePort(), clock: { now: () => T0 }, historyMs: 1000, maxEntityBytes: 1000, kinds: {} }).store.change, "undefined", "0.1.0 has no change");
});

test("the same writes through the single operations write a log and an archive byte-identical to 0.1.0's, step by step, across reopening, compaction and archiving, and are answered identically", () => {
	const dirs = [tempDir("old"), tempDir("new")];
	try {
		const old = session(released, releasedFile, dirs[0]);
		const now = session(current, currentFile, dirs[1]);
		const a = run(old, [...PHASE_ONE, ...PHASE_TWO]);
		const b = run(now, [...PHASE_ONE, ...PHASE_TWO]);
		old.close();
		now.close();
		assert.ok(old.files().archive.toString("utf8").trimEnd().split("\n").length > 1, "evicted changes were archived");
		assert.ok(old.files().log.toString("utf8").includes('"type":"base"'), "the active log was compacted to a base record");
		for (let i = 0; i < a.length; i++) assert.deepEqual(b[i], a[i], `step ${i}, ${a[i].label}`);
		assert.ok(now.files().log.equals(old.files().log), "the change logs are byte-identical");
		assert.ok(now.files().archive.equals(old.files().archive), "the archives are byte-identical");
	} finally {
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a log and an archive written by 0.1.0 open under this code without a byte touched, every write it recorded is recognised by its digest, and they go on exactly as 0.1.0 goes on with them", () => {
	const dirs = [tempDir("written"), tempDir("old"), tempDir("new")];
	try {
		const writer = session(released, releasedFile, dirs[0]);
		run(writer, PHASE_ONE);
		writer.close();
		const written = writer.files();
		assert.ok(written.archive.toString("utf8").trimEnd().split("\n").length > 1 && written.log.toString("utf8").includes('"type":"base"'), "0.1.0 wrote a compacted log and an archive holding evicted changes");
		for (const dir of dirs.slice(1)) fs.cpSync(dirs[0], dir, { recursive: true });
		const old = session(released, releasedFile, dirs[1]);
		const now = session(current, currentFile, dirs[2]);
		for (const s of [old, now]) s.set(T0 + 12_000);
		assert.deepEqual(now.open(), { opened: true });
		assert.ok(now.files().log.equals(written.log) && now.files().archive.equals(written.archive), "opening read both files without changing a byte");
		const digests = (bytes) => bytes.toString("utf8").trimEnd().split("\n").slice(1).map((line) => JSON.parse(line)).filter((r) => r.type !== "time").map((r) => [r.type, r.position, r.digest]);
		assert.deepEqual(digests(now.files().log), digests(written.log));
		assert.deepEqual(digests(now.files().archive), digests(written.archive));
		assert.deepEqual(old.open(), { opened: true });
		const a = run(old, PHASE_TWO);
		const b = run(now, PHASE_TWO);
		old.close();
		now.close();
		for (const [i, label] of [[0, "w11"], [1, "w12"]]) {
			assert.equal(b[i].outcome.outcome, "answered", `${label}, written by 0.1.0, is recognised by this code`);
			assert.equal(b[i].log, sha(written.log), `${label}'s repeat appended nothing`);
		}
		for (let i = 0; i < a.length; i++) assert.deepEqual(b[i], a[i], `step ${i}, ${a[i].label}`);
		assert.ok(now.files().log.equals(old.files().log) && now.files().archive.equals(old.files().archive), "the files go on byte-identical");
	} finally {
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("over memory storage the same writes keep the same records as 0.1.0", () => {
	const script = (api) => {
		let now = T0;
		const storage = api.createMemoryStoragePort();
		const { store } = api.openEntityStore({ storage, clock: { now: () => now }, historyMs: HISTORY_MS, maxEntityBytes: 65_536, kinds: KINDS });
		store.create(note("alpha"), W("a", "1"));
		store.update({ target: { id: "e1.1" }, name: "alpha-two" }, W("a", "2"));
		now = T0 + 5000;
		store.changes({ since: 0 });
		store.delete({ target: { id: "e1.1" } }, W("a", "3"));
		now = T0 + 20_000;
		store.create(note("beta"), W("a", "4"));
		return storage.records();
	};
	const records = script(current);
	assert.equal(JSON.stringify(records), JSON.stringify(script(released)));
	assert.ok(records.some((r) => r.type === "base"));
});

test("a log holding a change made through change, with a note or without, is refused by 0.1.0 as log-corrupt rather than misread", () => {
	for (const withNote of [false, true]) {
		const dir = tempDir(withNote ? "note" : "plain");
		try {
			const now = session(current, currentFile, dir);
			now.open();
			now.store.create(note("alpha"), W("a", "1"));
			const out = now.store.change({ writes: [{ operation: "create", input: note("beta") }], ...(withNote ? { note: { undo: [] } } : {}) }, W("a", "2"));
			assert.equal(out.outcome, "answered");
			now.close();
			const old = session(released, releasedFile, dir);
			const opening = old.open();
			assert.equal(opening.opened, false);
			assert.equal(opening.refusal.code, "log-corrupt");
			assert.equal(opening.refusal.details.line, 3);
			assert.match(opening.refusal.message, withNote ? /note/ : /entity/);
			old.close();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});
