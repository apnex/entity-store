// stated-history-bound - history is kept to a bound the application states, any reader can read the
// bound, and a reader behind it is told so (zorg's target, EM8; E4).
//
// Runs the shared suite's cases for this row locally - including EM8's schedule with a find as of 0 at
// 2000, refused before and after a restart with the clock set back, and as of 1 answered - then shows in
// the change log the time records EM8 makes the store append before each decision about retention. The
// same schedule also runs on the file port in a child process that is really killed, and the store is
// reopened with the clock set back.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort, LOG_HEADER } from "@apnex/entity-store/file-storage";
import { runUntilReadyThenKill } from "../support/child-process.js";
import { createLocalHarness } from "../support/local-harness.js";
import { KINDS, note, openLocal, T0 } from "../support/local-store.js";
import { SCHEDULE } from "../support/schedule.js";

registerEntityStoreSuite(test, createLocalHarness(), ["stated-history-bound"]);

const iso = (ms) => new Date(ms).toISOString();
const times = (storage) => storage.records().filter((r) => r.type === "time");

test("local: before deciding whether a write identity is retained, the store appends a time record when its time is later than the log's", () => {
	const { store, storage, clock } = openLocal({ historyMs: 1000 });
	const write = { writer: "a", writeId: "w" };
	store.create(note("alpha"), write);
	assert.deepEqual(times(storage), [], "a new identity needs no decision about retention");
	store.create(note("alpha"), write);
	assert.deepEqual(times(storage), [], "a repeat at the change's own time: the store's time is not later than the log's");
	clock.set(T0 + 400);
	store.create(note("alpha"), write);
	assert.deepEqual(times(storage), [{ type: "time", at: iso(T0 + 400) }], "a repeat at a later time appends that time first");
	clock.set(T0 + 100);
	store.create(note("alpha"), write);
	assert.equal(times(storage).length, 1, "with the clock set back the store's time is the log's, and nothing is appended");
});

test("local: before deciding whether a position below the store's is held, the store appends a time record; a find as of its own position needs none", () => {
	const { store, storage, clock } = openLocal({ historyMs: 1000 });
	store.create(note("alpha"), { writer: "a", writeId: "1" });
	clock.set(T0 + 50);
	store.find({ kind: "note" });
	store.find({ kind: "note", asOf: 1 });
	assert.deepEqual(times(storage), [], "a find as of the store's own position decides nothing about retention");
	store.find({ kind: "note", asOf: 0 });
	assert.deepEqual(times(storage), [{ type: "time", at: iso(T0 + 50) }]);
	const records = storage.records();
	assert.deepEqual(records.map((r) => r.type), ["change", "time"], "a time record takes no position and holds only type and at");
	assert.deepEqual(Object.keys(records[1]).sort(), ["at", "type"]);
	assert.equal(store.historyBound().answer.position, 1);
});

test("local: the bound is configuration, not stored: the change log holds no bound, and history-bound answers the bound given at opening", () => {
	const storage = openLocal({ historyMs: 1000 }).storage;
	const { store } = openLocal({ historyMs: 1000, storage });
	store.create(note("alpha"), { writer: "a", writeId: "1" });
	for (const record of storage.records()) {
		assert.deepEqual(Object.keys(record).sort(), ["answer", "at", "digest", "position", "type", "writeId", "writer", "writes"], "a change record holds EM15's fields and no bound");
	}
	assert.deepEqual(openLocal({ historyMs: 5000, storage }).store.historyBound().answer, { position: 1, historyMs: 5000 });
});

test("file port, process killed: changes at 1000 and 1900 with a bound of 1000, a find as of 0 at 2000 refused as position-not-held before the kill and after it, the clock set back to 1900, and as of 1 answered", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-schedule-"));
	try {
		const file = path.join(dir, "changes.log");
		const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "support", "schedule-child.js");
		const [first, second, found] = await runUntilReadyThenKill(child, [file, "find"], path.join(dir, "acks"));
		assert.deepEqual([first.outcome.answer.position, second.outcome.answer.position], [1, 2], "the changes at 1000 and 1900 were acknowledged");
		assert.equal(found.outcome.outcome, "refused", "the find as of 0 at 2000 was refused before the kill");
		assert.equal(found.outcome.refusal.code, "position-not-held");
		assert.deepEqual(found.outcome.refusal.details, { position: 0 });
		const timeRecords = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"type":"time"'));
		assert.deepEqual(timeRecords.map((l) => JSON.parse(l).at), ["1970-01-01T00:00:02.000Z"], "the decision at 2000 reached the change log before the kill");

		const { store, storage } = openLocal({ storage: createFileStoragePort(file), time: 1900, historyMs: SCHEDULE.historyMs });
		try {
			const after = store.find({ kind: "note", asOf: 0 });
			assert.deepEqual([after.outcome, after.refusal?.code, after.refusal?.details], ["refused", "position-not-held", { position: 0 }], "refused after the kill, the store's time being 2000, not the clock's 1900");
			assert.deepEqual(store.find({ kind: "note", asOf: 1 }), { outcome: "answered", answer: { position: 1, entries: [first.outcome.answer.entity], next: null } }, "as of 1 is answered with the state as of 1");
			assert.equal(store.historyBound().answer.position, 2);
		} finally {
			storage.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("D7-E1: 20-window (1000-write) stationary measurement across memory and file ports (with and without archiveFile) bounds active log records, file bytes, in-memory maps and restart I/O", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-d7-bench-"));
	try {
		const runBenchmark = (makeStorage, checkStorage) => {
			let now = T0;
			const storage = makeStorage();
			const opening = openEntityStore({ storage, clock: { now: () => now }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS });
			assert.equal(opening.opened, true);
			const store = opening.store;
			const permanentIds = [];
			let writeNum = 0;
			const nextWrite = () => ({ writer: "alice", writeId: `w-${++writeNum}` });

			const assertCheckpoint = (expectedPos, expectedFrontier) => {
				assert.equal(store.historyBound().answer.position, expectedPos);
				assert.equal(store.state.forgottenThrough, expectedFrontier);
				assert.equal(store.state.writes.size, 50);
				assert.equal(store.state.changeTimes.size, 50);
				assert.equal(store.state.changeItems.size, 50);
				assert.equal(store.state.changeRecords.size, 50);
				assert.equal(store.state.changeDigests.size, 50);
				assert.equal(store.state.itemSizes.size, 50);
				const expectedKeys = Array.from({ length: 50 }, (_, i) => expectedFrontier + 1 + i);
				assert.deepEqual([...store.state.itemSizes.keys()], expectedKeys);
				assert.equal(store.state.history.size, 25, "10 permanent live + 15 current-window transient entities; all earlier deleted transients evicted");
				const totalVersions = [...store.state.history.values()].reduce((sum, list) => sum + list.length, 0);
				assert.equal(totalVersions, 60, "10 baseline versions + 50 current-window versions");
			};

			let window2Metrics;
			for (let w = 0; w < 20; w++) {
				let step = 0;
				const stepClock = () => { now = T0 + w * 1_000 + step * 20; step++; };
				if (w === 0) {
					for (let i = 0; i < 10; i++) {
						stepClock();
						const created = store.create(note(`perm-${i}`, ["tier:perm"]), nextWrite());
						assert.equal(created.outcome, "answered");
						permanentIds.push(created.answer.entity.id);
					}
					for (let i = 0; i < 10; i++) {
						stepClock();
						assert.equal(store.update({ target: { id: permanentIds[i] }, body: { pointer: `https://example.com/p/${i}`, summary: `w0-u1-${i}` } }, nextWrite()).outcome, "answered");
					}
				} else {
					for (let round = 0; round < 2; round++) {
						for (let i = 0; i < 10; i++) {
							stepClock();
							assert.equal(store.update({ target: { id: permanentIds[i] }, body: { pointer: `https://example.com/p/${i}`, summary: `w${w}-r${round}-${i}` } }, nextWrite()).outcome, "answered");
						}
					}
				}
				for (let t = 0; t < 15; t++) {
					stepClock();
					const temp = store.create(note(`temp-${w}-${t}`, ["tier:temp"]), nextWrite());
					assert.equal(temp.outcome, "answered");
					stepClock();
					assert.equal(store.delete({ target: { id: temp.answer.entity.id } }, nextWrite()).outcome, "answered");
				}
				// Populate itemSizes for all 50 held positions in this window (Reading 50 o:F7).
				const ch = store.changes({ since: store.state.forgottenThrough });
				assert.equal(ch.outcome, "answered");
				assert.equal(ch.answer.changes.length, 50);

				if (w === 1) {
					assertCheckpoint(100, 50);
					window2Metrics = checkStorage(storage, 100, 50);
				}
				if (w === 19) {
					assertCheckpoint(1000, 950);
					checkStorage(storage, 1000, 950, window2Metrics);
				}
			}
			return { store, storage, now };
		};

		// 1. Memory storage port
		runBenchmark(
			() => createMemoryStoragePort(),
			(storage) => {
				const recs = storage.records();
				assert.equal(recs.length, 51, "1 base + 50 held changes");
				assert.equal(recs[0].type, "base");
				assert.equal(recs[0].entities.length, 10);
				return { count: recs.length };
			},
		);

		// 2. File storage port without archiveFile
		const noArchFile = path.join(dir, "no-archive.log");
		const noArch = runBenchmark(
			() => createFileStoragePort(noArchFile),
			(_storage, _pos, _frontier, w2) => {
				const lines = fs.readFileSync(noArchFile, "utf8").split("\n").slice(1, -1);
				assert.equal(lines.length, 51);
				const bytes = fs.statSync(noArchFile).size;
				if (w2 !== undefined) assert.ok(bytes <= w2.bytes * 1.05, `window 20 bytes (${bytes}) <= 1.05 * window 2 bytes (${w2.bytes})`);
				return { bytes };
			},
		);
		noArch.storage.close();

		// 3. File storage port with archiveFile
		const activeFile = path.join(dir, "active.log");
		const archiveFile = path.join(dir, "archive.log");
		const withArch = runBenchmark(
			() => createFileStoragePort(activeFile, { archiveFile }),
			(_storage, pos, frontier, w2) => {
				const activeLines = fs.readFileSync(activeFile, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
				assert.equal(activeLines.length, 51);
				assert.equal(activeLines[0].type, "base");
				assert.equal(activeLines[0].position, frontier);
				const archivedLines = fs.readFileSync(archiveFile, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
				assert.equal(archivedLines.length, frontier);
				const allChanges = [...archivedLines, ...activeLines.slice(1)];
				assert.equal(allChanges.length, pos);
				assert.deepEqual(allChanges.map((r) => r.position), Array.from({ length: pos }, (_, i) => i + 1));
				const activeBytes = fs.statSync(activeFile).size;
				const archiveBytes = fs.statSync(archiveFile).size;
				if (w2 !== undefined) {
					assert.ok(activeBytes <= w2.bytes * 1.05, `window 20 active bytes (${activeBytes}) <= 1.05 * window 2 (${w2.bytes})`);
					assert.ok(activeBytes < archiveBytes * 0.15, `active bytes (${activeBytes}) < 15% of archive bytes (${archiveBytes})`);
				}
				return { bytes: activeBytes };
			},
		);
		const liveBeforeRestart = withArch.store.find({ kind: "note" }).answer;
		const asOf950Before = withArch.store.find({ kind: "note", asOf: 950 }).answer;
		withArch.storage.close();

		// Reopen from compacted activeFile + archiveFile and measure bytes read from archiveFile (D7-E1: <= 65,600 bytes).
		let archiveBytesRead = 0;
		const origReadSync = fs.readSync;
		const origOpenSync = fs.openSync;
		const archFds = new Set();
		fs.openSync = function (p, ...rest) {
			const handle = origOpenSync.call(this, p, ...rest);
			if (String(p) === archiveFile) archFds.add(handle);
			return handle;
		};
		fs.readSync = function (fdArg, buffer, offset, length, position) {
			const n = origReadSync.call(this, fdArg, buffer, offset, length, position);
			if (archFds.has(fdArg)) archiveBytesRead += n;
			return n;
		};
		let reopenedPort;
		let reopened;
		try {
			reopenedPort = createFileStoragePort(activeFile, { archiveFile });
			reopened = openEntityStore({ storage: reopenedPort, clock: { now: () => withArch.now }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS });
		} finally {
			fs.readSync = origReadSync;
			fs.openSync = origOpenSync;
		}
		try {
			assert.equal(reopened.opened, true);
			assert.ok(archiveBytesRead > 0 && archiveBytesRead <= 65_600, `archiveFile bytes read on reopen (${archiveBytesRead}) <= 65,600`);
			assert.deepEqual(reopened.store.find({ kind: "note" }).answer, liveBeforeRestart);
			assert.deepEqual(reopened.store.find({ kind: "note", asOf: 950 }).answer, asOf950Before);
			assert.equal(reopened.store.find({ kind: "note", asOf: 949 }).refusal?.code, "position-not-held");
			assert.equal(reopened.store.changes({ since: 950 }).answer.changes.length, 50);
			assert.equal(reopened.store.follow({ kind: "note", since: 950 }).answer.through, 1000);
		} finally {
			reopenedPort?.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("D7-E1: position === 0 time-only log compaction, timeRecordCount >= 2 compaction, and forgottenThrough === position + 100-stale-query matrix", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-d7-matrix-"));
	try {
		// 1. Time-only log at position === 0 with multiple time records compacts to 1 time record and preserves latestAt.
		const timeOnlyFile = path.join(dir, "time-only.log");
		fs.writeFileSync(
			timeOnlyFile,
			`${LOG_HEADER}\n{"type":"time","at":"${iso(T0 + 100)}"}\n{"type":"time","at":"${iso(T0 + 500)}"}\n{"type":"time","at":"${iso(T0 + 500)}"}\n`,
		);
		let clockNow = T0;
		const timePort = createFileStoragePort(timeOnlyFile);
		const timeOpened = openEntityStore({ storage: timePort, clock: { now: () => clockNow }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.equal(timeOpened.opened, true);
		const compactedLines = fs.readFileSync(timeOnlyFile, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
		assert.deepEqual(compactedLines, [{ type: "time", at: iso(T0 + 500) }], "time-only log at position 0 compacts to one time record with no base");
		timePort.close();
		// Reopen the compacted time-only log a second time with the clock rolled back (Attempt 1 F4).
		const timePort2 = createFileStoragePort(timeOnlyFile);
		const timeOpened2 = openEntityStore({ storage: timePort2, clock: { now: () => T0 }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS });
		assert.equal(timeOpened2.opened, true);
		const firstWrite = timeOpened2.store.create(note("first"), { writer: "alice", writeId: "w-first" });
		assert.equal(firstWrite.outcome, "answered");
		assert.equal(firstWrite.answer.position, 1);
		assert.equal(firstWrite.answer.entity.created.at, iso(T0 + 500), "first accepted change preserves recovered latestAt when clock is rolled back");
		timePort2.close();

		// 1b. Interleaved [change, time, change, time] compacts to [change, change, time], and when forgottenThrough advances, to [base, change, change] (Attempt 1 F1).
		let ilNow = T0;
		const ilPort = createMemoryStoragePort();
		const ilStore = openEntityStore({ storage: ilPort, clock: { now: () => ilNow }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS }).store;
		ilStore.create(note("il-1"), { writer: "alice", writeId: "il-w1" });
		ilNow = T0 + 100;
		assert.equal(ilStore.find({ kind: "note", asOf: 0 }).outcome, "answered");
		ilNow = T0 + 200;
		ilStore.create(note("il-2"), { writer: "alice", writeId: "il-w2" });
		ilNow = T0 + 300;
		assert.equal(ilStore.find({ kind: "note", asOf: 0 }).outcome, "answered");
		assert.deepEqual(ilPort.records().map((r) => r.type), ["change", "change", "time"], "interleaved second time record compacts to [change, change, time]");
		ilNow = T0 + 1_000;
		ilStore.create(note("il-3"), { writer: "alice", writeId: "il-w3" });
		assert.deepEqual(ilPort.records().map((r) => r.type), ["base", "change", "change"], "frontier advance omits earlier interleaved time record");

		// 2. When forgottenThrough < position and repeated retention queries inside historyMs append time records, timeRecordCount >= 2 compacts them without writing time records to archiveFile.
		const activeFile = path.join(dir, "matrix.log");
		const archiveFile = path.join(dir, "matrix.archive.log");
		let now = T0;
		let reads = 0;
		let port = createFileStoragePort(activeFile, { archiveFile });
		let store = openEntityStore({ storage: port, clock: { now: () => { reads++; return now; } }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS }).store;
		const c1 = store.create(note("alpha", ["t:a"]), { writer: "alice", writeId: "w1" }).answer.entity;
		now = T0 + 100;
		const c2 = store.create(note("beta", ["t:b"]), { writer: "bob", writeId: "w2" }).answer.entity;
		now = T0 + 200;
		assert.equal(store.delete({ target: { id: c2.id } }, { writer: "bob", writeId: "w3" }).outcome, "answered");
		// Query asOf: 0 at advancing times inside historyMs (T0 + 300, 400, 500): timeRecordCount >= 2 compacts trailing times.
		for (const step of [300, 400, 500]) {
			now = T0 + step;
			assert.equal(store.find({ kind: "note", asOf: 0 }).outcome, "answered");
		}
		const midLines = fs.readFileSync(activeFile, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
		assert.equal(midLines.filter((r) => r.type === "time").length, 1, "trailing time records compacted to 1");
		assert.equal(fs.readFileSync(archiveFile, "utf8"), `${LOG_HEADER}\n`, "no time records written to archiveFile");

		// 3. Advance past changeAt(position) + historyMs (T0 + 2000) so forgottenThrough === position (3), then run 100 stale queries.
		now = T0 + 2_000;
		assert.equal(store.find({ kind: "note", asOf: 0 }).refusal?.code, "position-not-held");
		assert.equal(store.state.forgottenThrough, 3);
		for (let i = 1; i <= 100; i++) {
			now = T0 + 2_000 + i * 100;
			for (const p of [0, 1, 2]) {
				assert.equal(store.find({ kind: "note", asOf: p }).refusal?.code, "position-not-held");
				assert.equal(store.changes({ since: p }).refusal?.code, "position-not-held");
				assert.equal(store.follow({ kind: "note", since: p }).refusal?.code, "position-not-held");
			}
		}
		const afterStale = fs.readFileSync(activeFile, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
		assert.equal(afterStale.length, 2, "active log holds only 1 base + 1 time record after 100 stale queries");
		assert.deepEqual([afterStale[0].type, afterStale[0].position, afterStale[1].type], ["base", 3, "time"]);
		const archived = fs.readFileSync(archiveFile, "utf8").split("\n").slice(1, -1).map((l) => JSON.parse(l));
		assert.deepEqual(archived.map((r) => [r.type, r.position]), [["change", 1], ["change", 2], ["change", 3]]);

		// Check behavioral matrix before and after restart (with clock rolled back to T0 + 500).
		for (const phase of ["before-restart", "after-restart"]) {
			if (phase === "after-restart") {
				port.close();
				now = T0 + 500;
				port = createFileStoragePort(activeFile, { archiveFile });
				store = openEntityStore({ storage: port, clock: { now: () => { reads++; return now; } }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS }).store;
			}
			reads = 0;
			assert.deepEqual(store.read({ target: { id: c1.id } }).answer, { position: 3, entity: c1 }, `${phase}: read live entity`);
			assert.deepEqual(store.read({ target: { id: c2.id } }).answer, { position: 3, entity: null }, `${phase}: deleted entity is absent`);
			assert.deepEqual(store.find({ kind: "note" }).answer, { position: 3, entries: [c1], next: null }, `${phase}: find current`);
			assert.deepEqual(store.find({ kind: "note", asOf: 3 }).answer, { position: 3, entries: [c1], next: null }, `${phase}: find asOf position`);
			assert.deepEqual(store.changes({ since: 3 }).answer, { position: 3, changes: [], next: null }, `${phase}: changes since position`);
			assert.deepEqual(store.follow({ kind: "note", since: 3 }).answer, { position: 3, through: 3, changes: [] }, `${phase}: follow since position`);
			assert.equal(reads, 0, `${phase}: current-position reads/finds/changes/follow read no clock`);

			for (const p of [0, 1, 2]) {
				assert.equal(store.find({ kind: "note", asOf: p }).refusal?.code, "position-not-held", `${phase}: find asOf ${p}`);
				assert.equal(store.changes({ since: p }).refusal?.code, "position-not-held", `${phase}: changes since ${p}`);
				assert.equal(store.follow({ kind: "note", since: p }).refusal?.code, "position-not-held", `${phase}: follow since ${p}`);
			}
			assert.equal(store.checkRepeat("create", note("alpha", ["t:a"]), { writer: "alice", writeId: "w1" }).repeat, "none", `${phase}: w1 forgotten`);
			assert.equal(store.checkRepeat("delete", { target: { id: c2.id } }, { writer: "bob", writeId: "w3" }).repeat, "none", `${phase}: w3 forgotten`);
		}
		// Run 100 stale queries after restart too, advancing clock and confirming active log stays at 2 records (Attempt 1 F4).
		for (let i = 1; i <= 100; i++) {
			now = T0 + 20_000 + i * 100;
			for (const p of [0, 1, 2]) {
				assert.equal(store.find({ kind: "note", asOf: p }).refusal?.code, "position-not-held");
				assert.equal(store.changes({ since: p }).refusal?.code, "position-not-held");
				assert.equal(store.follow({ kind: "note", since: p }).refusal?.code, "position-not-held");
			}
		}
		assert.equal(fs.readFileSync(activeFile, "utf8").split("\n").slice(1, -1).length, 2, "still 2 active records after 100 post-restart stale queries");
		// Expired create of live name meets name-taken; expired delete of deleted entity meets not-found; expired update runs afresh at position 4, revision 2.
		assert.equal(store.create(note("alpha", ["t:a"]), { writer: "alice", writeId: "w1" }).refusal?.code, "name-taken");
		assert.equal(store.delete({ target: { id: c2.id } }, { writer: "bob", writeId: "w3" }).refusal?.code, "not-found");
		const freshUpdate = store.update({ target: { id: c1.id }, tags: ["t:a", "t:updated"] }, { writer: "alice", writeId: "w1" });
		assert.equal(freshUpdate.outcome, "answered");
		assert.deepEqual([freshUpdate.answer.position, freshUpdate.answer.entity.revision], [4, 2]);
		// Delete the remaining live entity and advance past historyMs for the empty-live-set base variant.
		assert.equal(store.delete({ target: { id: c1.id } }, { writer: "alice", writeId: "w4" }).answer.position, 5);
		now = T0 + 50_000;
		assert.equal(store.find({ kind: "note", asOf: 3 }).refusal?.code, "position-not-held");
		assert.equal(store.state.forgottenThrough, 5);
		assert.equal(store.state.history.size, 0, "empty live set leaves 0 entries in history");
		port.close();
		port = createFileStoragePort(activeFile, { archiveFile });
		store = openEntityStore({ storage: port, clock: { now: () => now }, historyMs: 1_000, maxEntityBytes: 65_536, kinds: KINDS }).store;
		assert.deepEqual(store.find({ kind: "note" }).answer, { position: 5, entries: [], next: null });
		const freshCreate = store.create(note("alpha"), { writer: "alice", writeId: "w5" });
		assert.equal(freshCreate.answer.position, 6);
		port.close();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
