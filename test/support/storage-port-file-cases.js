// storage-port-file-cases - the file storage port's change log (zorg's target, EM15; D24), registered by
// ../contract/storage-port.test.js: the header and one line per record, one synchronous write and
// fdatasync per append before the store answers, truncation of a final line that is incomplete or does not
// parse, the faults that stop a store opening, naming the line, and a failed append stopping the store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { KINDS, note, openLocal, T0 } from "./local-store.js";

const HEADER = '{"log":"entity-store","version":1}';
const withLog = (body) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-log-"));
	try {
		return body(path.join(dir, "changes.log"), dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};
const openFile = (file) => openEntityStore({ storage: createFileStoragePort(file), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
const write = (n) => ({ writer: "alice", writeId: `w${n}` });

/** Writes a log of three changes and returns its lines, header first, with the trailing empty string dropped. */
function threeChanges(file) {
	const { store } = openLocal({ storage: createFileStoragePort(file) });
	store.create(note("a"), write(1));
	store.create(note("b"), write(2));
	store.update({ target: { id: "e1.1" }, tags: ["x:y"] }, write(3));
	return fs.readFileSync(file, "utf8").split("\n").slice(0, -1);
}

test("file port: an absent log is created with its header, and each record is one line of JSON ending in a newline", () => withLog((file) => {
	assert.equal(openFile(file).opened, true);
	assert.equal(fs.readFileSync(file, "utf8"), `${HEADER}\n`);
	const lines = threeChanges(file);
	assert.equal(lines.length, 4);
	assert.equal(lines[0], HEADER);
	const records = lines.slice(1).map((l) => JSON.parse(l));
	assert.deepEqual(records.map((r) => [r.type, r.position, r.writes.length]), [["change", 1, 1], ["change", 2, 1], ["change", 3, 1]]);
	for (const r of records) assert.deepEqual(Object.keys(r).sort(), ["answer", "at", "digest", "position", "type", "writeId", "writer", "writes"]);
	assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
}));

test("file port: an empty file, or one holding a beginning of the header and no newline, holds no record and is given its header", () => withLog((file) => {
	for (const start of ["", HEADER.slice(0, 1), HEADER.slice(0, 12), HEADER]) {
		fs.writeFileSync(file, start);
		assert.equal(openFile(file).opened, true, `a file holding ${JSON.stringify(start)} opens`);
		assert.equal(fs.readFileSync(file, "utf8"), `${HEADER}\n`, `a file holding ${JSON.stringify(start)} is given its header`);
	}
	fs.writeFileSync(file, '{"log":"other"');
	const refused = openFile(file);
	assert.equal(refused.opened, false, "a file holding something other than a beginning of the header is not given one");
	assert.equal(refused.refusal.code, "log-corrupt");
}));

test("file port: an append is one synchronous write followed by fdatasync, both done before the store answers", () => withLog((file) => {
	const { store } = openLocal({ storage: createFileStoragePort(file) });
	const calls = [];
	const { writeSync, fdatasyncSync } = fs;
	fs.writeSync = (...args) => { calls.push("write"); return writeSync(...args); };
	fs.fdatasyncSync = (...args) => { calls.push("fdatasync"); return fdatasyncSync(...args); };
	try {
		const outcome = store.create(note("a"), write(1));
		calls.push("answered");
		assert.equal(outcome.outcome, "answered");
	} finally {
		fs.writeSync = writeSync;
		fs.fdatasyncSync = fdatasyncSync;
	}
	assert.deepEqual(calls, ["write", "fdatasync", "answered"]);
}));

test("file port: a final line that is incomplete, or complete but not parsing, is discarded and the file cut back to the last whole record", () => withLog((file) => {
	const lines = threeChanges(file);
	const whole = fs.readFileSync(file);
	for (const tail of ['{"type":"change","position":4', "not json\n", "{\"type\":\"chan\n", "\n", '{"type":"time","at":"2026-10-09T10:00:00.000Z"}']) {
		fs.writeFileSync(file, Buffer.concat([whole, Buffer.from(tail)]));
		const opening = openFile(file);
		assert.equal(opening.opened, true, JSON.stringify(tail));
		assert.equal(opening.store.historyBound().answer.position, 3);
		assert.deepEqual(fs.readFileSync(file), whole, `cut back after ${JSON.stringify(tail)}`);
	}
	const opening = openFile(file);
	assert.equal(opening.store.create(note("c"), write(4)).answer.position, 4, "the next change takes the next position");
	assert.equal(fs.readFileSync(file, "utf8").split("\n").length, lines.length + 2);
}));

/** Rewrites one line of a three-change log, opens it, and returns the refusal to open. */
function corruptLine(file, lineNumber, change) {
	const lines = threeChanges(file);
	lines[lineNumber - 1] = change(lines[lineNumber - 1]);
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	const opening = openFile(file);
	assert.equal(opening.opened, false, `line ${lineNumber} rewritten`);
	return opening.refusal;
}
const edit = (f) => (line) => { const r = JSON.parse(line); f(r); return JSON.stringify(r); };

test("file port: an earlier line that does not parse, a record lacking a field, holding another or holding one of the wrong type, and a gap in positions each stop the store opening, naming the line", () => {
	const cases = [
		[2, () => "not json", "does not parse"],
		[3, edit((r) => { delete r.digest; }), "lacks the field digest"],
		[2, edit((r) => { r.extra = 1; }), "holds the field extra"],
		[3, edit((r) => { r.position = "2"; }), "position"],
		[2, edit((r) => { r.at = "yesterday"; }), "at"],
		[3, edit((r) => { r.writes = []; }), "writes"],
		[2, edit((r) => { delete r.writes[0].entity; }), "lacks the field entity"],
		[3, edit((r) => { r.writes[0].operation = "upsert"; }), "operation"],
		[2, edit((r) => { r.writes[0].entity.revision = 0; }), "revision"],
		[4, edit((r) => { delete r.answer.entity; r.answer.other = 1; }), "answer"],
		[3, edit((r) => { r.position = 3; }), "position is 3 where 2 follows"],
		[2, edit((r) => { r.position = 2; }), "position is 2 where 1 follows"],
		[3, () => '{"type":"time"}', "lacks the field at"],
		[2, () => '{"type":"note","at":"2026-10-09T10:00:00.000Z"}', "neither change nor time"],
		[1, () => '{"log":"other","version":1}', "header"],
		[4, edit((r) => { delete r.writer; }), "lacks the field writer"],
	];
	for (const [line, change, says] of cases) withLog((file) => {
		const refusal = corruptLine(file, line, change);
		assert.equal(refusal.code, "log-corrupt", says);
		assert.equal(refusal.details.line, line, `${says}: the refusal names line ${line}`);
		assert.match(refusal.message, new RegExp(`line ${line}`), says);
		assert.ok(refusal.message.includes(says), `${refusal.message} says ${says}`);
	});
});

test("file port: a log that cannot be created is refused at opening as log-unwritable", () => withLog((file, dir) => {
	const opening = openFile(path.join(dir, "missing-directory", "changes.log"));
	assert.equal(opening.opened, false);
	assert.equal(opening.refusal.code, "log-unwritable");
}));

test("a failed append stops the store: the write is not applied and the store answers nothing more", () => withLog((file) => {
	const storage = createFileStoragePort(file);
	const { store } = openLocal({ storage });
	store.create(note("a"), write(1));
	storage.close();
	assert.throws(() => store.create(note("b"), write(2)), (e) => e.code === "store-stopped");
	assert.throws(() => store.read({ target: { id: "e1.1" } }), (e) => e.code === "store-stopped", "not even a read is answered");
	assert.throws(() => store.historyBound(), (e) => e.code === "store-stopped");
	const reopened = openFile(file);
	assert.equal(reopened.store.historyBound().answer.position, 1, "the failed change was never applied");
}));

test("a failed append of a time record stops the store too", () => {
	let now = T0;
	let fail = false;
	const records = [];
	const storage = { load: () => ({ ok: true, records: [] }), append: (r) => { if (fail) throw new Error("disk gone"); records.push(r); } };
	const opening = openEntityStore({ storage, clock: { now: () => now }, historyMs: 1000, maxEntityBytes: 65_536, kinds: KINDS });
	opening.store.create(note("a"), write(1));
	now += 10;
	fail = true;
	assert.throws(() => opening.store.create(note("a"), write(1)), (e) => e.code === "store-stopped" && e.cause.message === "disk gone");
	assert.throws(() => opening.store.find({ kind: "note" }), (e) => e.code === "store-stopped");
});

test("D7-E1, file port: base record validation, unknown-kind/misfit-body base recovery, archive corruption and digest provenance, oversized archive tail, path/symlink/hardlink collisions, crash recovery and fs operation ordering", async () => {
	const iso = (ms) => new Date(ms).toISOString();
	// 1. Base record validation: misplaced base, missing/extra fields, bad position/at/digest, bad envelope, created > changed, changed > base.position, duplicate id, duplicate (kind, name), and gap after base.
	const stamp = (pos, at = "2026-10-09T10:00:00.000Z") => ({ position: pos, at, writer: "alice" });
	const env = (id, name, rev = 1, cPos = 1, uPos = 1, kind = "note", body = { pointer: "https://e.x/a", summary: "s" }) => ({
		id, kind, name, tags: [], body, revision: rev, created: stamp(cPos), changed: stamp(uPos),
	});
	const validDigest = "a".repeat(64);
	const validBase = (pos = 2, entities = [env("e1.1", "alpha", 1, 1, 1)]) => ({
		type: "base", position: pos, at: "2026-10-09T10:00:00.000Z", digest: validDigest, entities,
	});
	const validChange = (pos) => ({
		type: "change", position: pos, at: "2026-10-09T10:00:01.000Z", writer: "alice", writeId: `w${pos}`, digest: "b".repeat(64),
		answer: { position: pos, entity: env(`e${pos}.1`, `n${pos}`, 1, pos, pos) },
		writes: [{ operation: "create", id: `e${pos}.1`, entity: env(`e${pos}.1`, `n${pos}`, 1, pos, pos) }],
	});

	const baseFaults = [
		[[validChange(1), validBase(2)], 3, "not the change log's first record"],
		[[{ type: "base", position: 1, at: "2026-10-09T10:00:00.000Z", entities: [] }], 2, "lacks the field digest"],
		[[{ ...validBase(1, []), extra: 1 }], 2, "holds the field extra"],
		[[{ ...validBase(1, []), position: 0 }], 2, "position"],
		[[{ ...validBase(1, []), at: "not-a-time" }], 2, "at"],
		[[{ ...validBase(1, []), digest: "xyz" }], 2, "digest"],
		[[{ ...validBase(1, []), entities: "none" }], 2, "entities"],
		[[validBase(2, [{ id: "e1.1" }])], 2, "base entity 1"],
		[[validBase(2, [env("e1.1", "alpha", 1, 2, 1)])], 2, "created.position (2) or changed.position (1)"],
		[[validBase(2, [env("e1.1", "alpha", 1, 1, 3)])], 2, "after the base position (2)"],
		[[validBase(2, [env("e1.1", "alpha"), env("e1.1", "beta")])], 2, "duplicates the id e1.1"],
		[[validBase(2, [env("e1.1", "alpha"), env("e2.1", "alpha")])], 2, "duplicates the name alpha"],
		[[validBase(2, []), validChange(4)], 3, "position is 4 where 3 follows"],
	];
	for (const [recs, expectedLine, says] of baseFaults) {
		withLog((file) => {
			fs.writeFileSync(file, `${HEADER}\n${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
			const res = openFile(file);
			assert.equal(res.opened, false, says);
			assert.equal(res.refusal.code, "log-corrupt", says);
			assert.equal(res.refusal.details.line, expectedLine, says);
			assert.ok(res.refusal.message.includes(says), `${res.refusal.message} includes ${says}`);
		});
	}

	// 2. Unknown kind and misfitting body in base.entities recover structurally just as in change records (Reading 49 o:F9).
	withLog((file) => {
		const unknownKindEntity = env("e1.1", "unregistered", 1, 1, 1, "unregistered-kind", { anything: 123 });
		const misfitBodyEntity = env("e2.1", "misfit-note", 1, 2, 2, "note", { wrong: true });
		fs.writeFileSync(file, `${HEADER}\n${JSON.stringify(validBase(2, [unknownKindEntity, misfitBodyEntity]))}\n`);
		const port = createFileStoragePort(file);
		const res = openEntityStore({ storage: port, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		try {
			assert.equal(res.opened, true, "structural checkEnvelope accepts unknown kinds and misfitting bodies in base");
			assert.deepEqual(res.store.read({ target: { id: "e2.1" } }).answer, { position: 2, entity: misfitBodyEntity });
		} finally {
			port.close();
		}
	});

	// 3. Archive corruption, swapped digest/at mismatch, and late archive enablement refused as log-corrupt.
	withLog((file, dir) => {
		const arch = path.join(dir, "arch.log");
		fs.writeFileSync(file, `${HEADER}\n${JSON.stringify(validBase(1, []))}\n`);
		// Empty archive when active log starts with base (late archive enablement) -> log-corrupt.
		const late = openEntityStore({ storage: createFileStoragePort(file, { archiveFile: arch }), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.deepEqual([late.opened, late.refusal?.code], [false, "log-corrupt"]);
		// Wrong archive header -> log-corrupt.
		fs.writeFileSync(arch, '{"log":"other","version":1}\n');
		const badHead = openEntityStore({ storage: createFileStoragePort(file, { archiveFile: arch }), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.deepEqual([badHead.opened, badHead.refusal?.code], [false, "log-corrupt"]);
		// Time record in archive -> log-corrupt.
		fs.writeFileSync(arch, `${HEADER}\n{"type":"time","at":"2026-10-09T10:00:00.000Z"}\n`);
		const timeInArch = openEntityStore({ storage: createFileStoragePort(file, { archiveFile: arch }), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.deepEqual([timeInArch.opened, timeInArch.refusal?.code], [false, "log-corrupt"]);
		// Swapped archive at same position 1 with different digest -> log-corrupt (Reading 50 o:F5).
		fs.writeFileSync(arch, `${HEADER}\n${JSON.stringify({ ...validChange(1), at: "2026-10-09T10:00:00.000Z", digest: "c".repeat(64) })}\n`);
		const badDigest = openEntityStore({ storage: createFileStoragePort(file, { archiveFile: arch }), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.deepEqual([badDigest.opened, badDigest.refusal?.code], [false, "log-corrupt"]);
		// Same position and digest, but mismatched at -> log-corrupt (Reading 51 o:F1).
		fs.writeFileSync(arch, `${HEADER}\n${JSON.stringify({ ...validChange(1), at: "2026-10-09T10:00:00.500Z", digest: validDigest })}\n`);
		const badAt = openEntityStore({ storage: createFileStoragePort(file, { archiveFile: arch }), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.deepEqual([badAt.opened, badAt.refusal?.code], [false, "log-corrupt"]);
		// Matching position, at and digest + torn final line -> torn line cut back and opens cleanly.
		const goodArchLine = JSON.stringify({ ...validChange(1), at: "2026-10-09T10:00:00.000Z", digest: validDigest });
		fs.writeFileSync(arch, `${HEADER}\n${goodArchLine}\n{"type":"change","position":2,"torn`);
		const port = createFileStoragePort(file, { archiveFile: arch });
		const ok = openEntityStore({ storage: port, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.equal(ok.opened, true);
		assert.equal(fs.readFileSync(arch, "utf8"), `${HEADER}\n${goodArchLine}\n`, "torn tail in archiveFile is cut back");
		port.close();
	});

	// 4. Oversized (> 64 KiB) archived change record tail reading across chunk boundaries (Reading 50 o:F2).
	withLog((file, dir) => {
		const arch = path.join(dir, "big-arch.log");
		const bigSummary = "x".repeat(120_000);
		const bigEntity = env("e1.1", "big", 1, 1, 1, "note", { pointer: "https://e.x/big", summary: bigSummary });
		const bigChange = {
			type: "change", position: 1, at: "2026-10-09T10:00:00.000Z", writer: "alice", writeId: "w-big", digest: validDigest,
			answer: { position: 1, entity: bigEntity }, writes: [{ operation: "create", id: "e1.1", entity: bigEntity }],
		};
		fs.writeFileSync(arch, `${HEADER}\n${JSON.stringify(bigChange)}\n`);
		fs.writeFileSync(file, `${HEADER}\n${JSON.stringify(validBase(1, [bigEntity]))}\n`);
		const port = createFileStoragePort(file, { archiveFile: arch });
		const ok = openEntityStore({ storage: port, clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 262_144, kinds: KINDS });
		assert.equal(ok.opened, true, "oversized (> 64 KiB) archived record is read across chunk boundaries");
		port.close();
	});

	// 5. Path, symlink and hard-link collisions refused as log-unwritable with existing files intact (Reading 49 o:F2).
	withLog((file, dir) => {
		fs.writeFileSync(file, `${HEADER}\n`);
		const originalBytes = fs.readFileSync(file);
		// archive === file and archive === file.compact
		for (const badArch of [file, `${file}.compact`]) {
			const res = openEntityStore({ storage: createFileStoragePort(file, { archiveFile: badArch }), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
			assert.deepEqual([res.opened, res.refusal?.code], [false, "log-unwritable"]);
			assert.deepEqual(fs.readFileSync(file), originalBytes);
		}
		// Hard link alias of file
		const hardLink = path.join(dir, "hardlink.log");
		fs.linkSync(file, hardLink);
		const hardRes = openEntityStore({ storage: createFileStoragePort(file, { archiveFile: hardLink }), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.deepEqual([hardRes.opened, hardRes.refusal?.code], [false, "log-unwritable"]);
		assert.deepEqual(fs.readFileSync(file), originalBytes);
		// Symlink at archiveFile and symlink at ${file}.compact
		const targetFile = path.join(dir, "innocent.txt");
		fs.writeFileSync(targetFile, "keep-me");
		const symArch = path.join(dir, "sym-arch.log");
		fs.symlinkSync(targetFile, symArch);
		const symArchRes = openEntityStore({ storage: createFileStoragePort(file, { archiveFile: symArch }), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.deepEqual([symArchRes.opened, symArchRes.refusal?.code], [false, "log-unwritable"]);
		assert.equal(fs.readFileSync(targetFile, "utf8"), "keep-me");
		fs.symlinkSync(targetFile, `${file}.compact`);
		const symCompactRes = openEntityStore({ storage: createFileStoragePort(file), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.deepEqual([symCompactRes.opened, symCompactRes.refusal?.code], [false, "log-unwritable"]);
		assert.equal(fs.readFileSync(targetFile, "utf8"), "keep-me");
	});

	// 6. Crash recovery between archiveFile flush and ${file}.compact rename (first compaction and already-based log, with > 64 KiB overlap) and fs operation ordering (Reading 51 o:F1, o:F2, o:F7).
	withLog((file, dir) => {
		const arch = path.join(dir, "crash-arch.log");
		let now = T0;
		let port = createFileStoragePort(file, { archiveFile: arch });
		let store = openEntityStore({ storage: port, clock: { now: () => now }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS }).store;
		store.create(note("n1"), write(1));
		now = T0 + 100;
		store.create(note("n2"), write(2));
		const uncompactedActive = fs.readFileSync(file);

		// Observe exact fs operation ordering during compact (Reading 51 o:F7).
		const ops = [];
		const origOpen = fs.openSync;
		const origWrite = fs.writeSync;
		const origFdatasync = fs.fdatasyncSync;
		const origClose = fs.closeSync;
		const origRename = fs.renameSync;
		const origFsync = fs.fsyncSync;
		const tracked = new Map();
		fs.openSync = function (p, flags, mode) {
			const h = origOpen.call(this, p, flags, mode);
			const s = String(p);
			if (s === arch) { tracked.set(h, "arch"); ops.push("open:arch"); }
			else if (s === `${file}.compact`) {
				tracked.set(h, "compact");
				const excl = typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0 && (flags & fs.constants.O_EXCL) !== 0;
				ops.push(excl ? "open:compact:excl" : "open:compact");
			} else if (s === file) { tracked.set(h, "file"); ops.push("open:file"); }
			else if (s === path.dirname(file)) { tracked.set(h, "dir"); }
			return h;
		};
		fs.writeSync = function (h, ...rest) {
			if (tracked.has(h)) ops.push(`write:${tracked.get(h)}`);
			return origWrite.call(this, h, ...rest);
		};
		fs.fdatasyncSync = function (h) {
			if (tracked.has(h)) ops.push(`fdatasync:${tracked.get(h)}`);
			return origFdatasync.call(this, h);
		};
		fs.fsyncSync = function (h) {
			if (tracked.get(h) === "dir") ops.push("fsync:dir");
			return origFsync.call(this, h);
		};
		fs.closeSync = function (h) {
			if (tracked.has(h) && tracked.get(h) !== "dir") ops.push(`close:${tracked.get(h)}`);
			return origClose.call(this, h);
		};
		fs.renameSync = function (oldP, newP) {
			if (String(oldP) === `${file}.compact` && String(newP) === file) ops.push("rename:compact->file");
			return origRename.call(this, oldP, newP);
		};
		try {
			now = T0 + 1_050;
			store.create(note("n3"), write(3));
		} finally {
			fs.openSync = origOpen;
			fs.writeSync = origWrite;
			fs.fdatasyncSync = origFdatasync;
			fs.fsyncSync = origFsync;
			fs.closeSync = origClose;
			fs.renameSync = origRename;
		}
		assert.deepEqual(ops, [
			"open:arch", "write:arch", "fdatasync:arch", "close:arch",
			"open:compact:excl", "write:compact", "fdatasync:compact", "close:compact",
			"rename:compact->file", "fsync:dir", "open:file",
		], "exact fs operation ordering during compact");
		port.close();

		// Simulate crash after archive flush (position 1 archived) and before rename on first compaction (file still has no base).
		const compactedAt1 = fs.readFileSync(file);
		fs.writeFileSync(file, uncompactedActive);
		port = createFileStoragePort(file, { archiveFile: arch });
		const rec1 = openEntityStore({ storage: port, clock: { now: () => now }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.equal(rec1.opened, true, "reovers cleanly when archive was flushed before first rename");
		const archAfterRec1 = fs.readFileSync(arch, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
		assert.deepEqual(archAfterRec1.map((r) => r.position), [1], "position 1 is not duplicated in archive");
		port.close();

		// Now write two large changes (> 40 KiB each, so > 80 KiB total > 64 KiB tail chunk) at T0 + 1100, then advance to T0 + 2500 so they archive, and simulate crash before rename on the already-based log (Reading 51 o:F2).
		fs.writeFileSync(file, compactedAt1);
		port = createFileStoragePort(file, { archiveFile: arch });
		store = openEntityStore({ storage: port, clock: { now: () => now }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS }).store;
		now = T0 + 1_100;
		assert.equal(store.create({ kind: "any", name: "big-4", tags: [], body: { pointer: "https://e.x/4", summary: "s".repeat(40_000) } }, write(4)).outcome, "answered");
		assert.equal(store.create({ kind: "any", name: "big-5", tags: [], body: { pointer: "https://e.x/5", summary: "s".repeat(40_000) } }, write(5)).outcome, "answered");
		const basedBeforeSecondCompact = fs.readFileSync(file);
		now = T0 + 2_500;
		store.create(note("n6"), write(6));
		port.close();
		// Restore file to `basedBeforeSecondCompact` (which has base at 1 and changes 2, 3, 4, 5) while arch has 1..5 (> 80 KiB after position 1!).
		fs.writeFileSync(file, basedBeforeSecondCompact);
		port = createFileStoragePort(file, { archiveFile: arch });
		const rec2 = openEntityStore({ storage: port, clock: { now: () => now }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.equal(rec2.opened, true, "crash-before-rename recovery on already-based log scans backwards across > 64 KiB overlap to B.position");
		const archAfterRec2 = fs.readFileSync(arch, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
		assert.deepEqual(archAfterRec2.map((r) => r.position), [1, 2, 3, 4, 5], "no duplicate or lost archived changes");
		port.close();
	});

	// 7. Opening-time compact throw returns log-unwritable; runtime compact throw stops store and rejects pending waitForChange (Reading 49 o:F5, Reading 51 o:F4).
	let now = T0;
	const expiredChange = { ...validChange(1), at: iso(T0) };
	const openFailPort = {
		load: () => ({ ok: true, records: [{ line: 2, record: expiredChange }, { line: 3, record: { type: "time", at: iso(T0 + 5_000) } }] }),
		append: () => {},
		compact: () => { throw new Error("compact disk full at open"); },
	};
	const openFailed = openEntityStore({ storage: openFailPort, clock: { now: () => T0 + 5_000 }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS });
	assert.deepEqual([openFailed.opened, openFailed.refusal?.code, openFailed.refusal?.details], [false, "log-unwritable", { line: null }]);

	let failCompact = false;
	const mem = [];
	const runtimePort = {
		load: () => ({ ok: true, records: [] }),
		append: (r) => { mem.push(r); },
		compact: () => { if (failCompact) throw new Error("compact failed at runtime"); },
	};
	const rtOpened = openEntityStore({ storage: runtimePort, clock: { now: () => now }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS });
	assert.equal(rtOpened.opened, true);
	rtOpened.store.create(note("a"), write(1));
	let removedListeners = 0;
	const fakeSignal = { aborted: false, addEventListener: () => {}, removeEventListener: () => { removedListeners++; } };
	const pendingWait = rtOpened.store.waitForChange(1, { signal: fakeSignal });
	now = T0 + 2_000;
	failCompact = true;
	assert.throws(() => rtOpened.store.find({ kind: "note", asOf: 0 }), (e) => e.code === "store-stopped" && e.cause.message === "compact failed at runtime");
	await assert.rejects(pendingWait, (e) => e.code === "store-stopped" && e.cause.message === "compact failed at runtime");
	assert.equal(removedListeners, 1, "pending wait's abort listener was removed when compact failed");
	assert.throws(() => rtOpened.store.read({ target: { id: "e1.1" } }), (e) => e.code === "store-stopped");
});
