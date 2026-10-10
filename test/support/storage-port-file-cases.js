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
