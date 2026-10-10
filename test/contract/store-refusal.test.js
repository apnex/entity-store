// store-refusal - a refusal of a write or read says, in the shared refusal form, what was wrong and how to
// fix it (zorg's target, EM9; and the store's own limits and opening refusals of EM10).
//
// Runs the shared suite's cases for this row locally - including E11's names of 63 and 64 characters,
// tags of 127 and 128, an unknown kind, a target of 200 characters and a reused identity with an over-long
// name - then the cases that cannot cross AGP in a request, integers beyond the safe range, and the
// refusals to open, which are the hosting application's to see.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHAPE_DIALECT_ID } from "@apnex/shape-check";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness } from "../support/local-harness.js";
import { KINDS, note, openLocal, T0 } from "../support/local-store.js";

registerEntityStoreSuite(test, createLocalHarness(), ["store-refusal"]);

const UNSAFE = 9007199254740992;
let ids = 0;
const write = () => ({ writer: "alice", writeId: `w${++ids}` });
const any = (name, body) => ({ kind: "any", name, tags: [], body });

test("local: an integer more than 9007199254740991 from zero is refused as unsafe-number, naming the first such place in SD5's order", () => {
	const { store } = openLocal();
	const cases = [
		[UNSAFE, "/body"],
		[-UNSAFE, "/body"],
		[1e300, "/body"],
		[{ a: { b: UNSAFE } }, "/body/a/b"],
		[[0, [UNSAFE]], "/body/1/0"],
		[{ b: UNSAFE, a: [1, -UNSAFE] }, "/body/a/1"],
		[[0, 1, UNSAFE, 3, 4, 5, 6, 7, 8, 9, UNSAFE], "/body/2"],
		[{ "a/b": { "c~d": UNSAFE } }, "/body/a~1b/c~0d"],
	];
	for (const [i, [body, pointer]] of cases.entries()) {
		const outcome = store.create(any(`u${i}`, body), write());
		assert.equal(outcome.outcome, "refused", `body ${i}`);
		assert.deepEqual(Object.keys(outcome.refusal).sort(), ["code", "details", "fix", "part", "what", "why"]);
		assert.equal(outcome.refusal.code, "unsafe-number");
		assert.deepEqual(outcome.refusal.details, { pointer }, `body ${i}`);
	}
	const safe = store.create(any("safe", { n: 9007199254740991, m: -9007199254740991, f: 0.5 }), write());
	assert.equal(safe.outcome, "answered");
	const update = store.update({ target: { id: safe.answer.entity.id }, body: { n: UNSAFE } }, write());
	assert.deepEqual([update.refusal.code, update.refusal.details], ["unsafe-number", { pointer: "/body/n" }], "an update leaving an unsafe integer");
	assert.equal(store.historyBound().answer.position, 1, "no refusal took a position");
});

test("local: unsafe-number comes after misfit, entity-too-large and entity-too-deep in EM9's order", () => {
	const { store } = openLocal({ maxEntityBytes: 1000 });
	const misfit = store.create({ kind: "note", name: "a", tags: [], body: { pointer: "https://e.x/", summary: "s", n: UNSAFE } }, write());
	assert.equal(misfit.refusal.code, "misfit");
	assert.equal(store.create(any("b", { n: UNSAFE, pad: "x".repeat(2000) }), write()).refusal.code, "entity-too-large");
	let deep = UNSAFE;
	for (let i = 0; i < 27; i++) deep = [deep];
	assert.equal(store.create(any("c", deep), write()).refusal.code, "entity-too-deep");
});

// A body nesting `levels` arrays around 0, built from JSON text as a caller would parse it: 4000 levels is
// an ordinary value of 8001 bytes that fits EM10's input shape, far deeper than the 27-level envelope.
const deepArrays = (levels) => JSON.parse(`${"[".repeat(levels)}0${"]".repeat(levels)}`);
const REFUSAL_FIELDS = ["code", "details", "fix", "part", "what", "why"];
const assertRefused = (outcome, code, details, message) => {
	assert.equal(outcome.outcome, "refused", message);
	assert.deepEqual(Object.keys(outcome.refusal).sort(), REFUSAL_FIELDS, message);
	assert.deepEqual([outcome.refusal.part, outcome.refusal.code, outcome.refusal.details], ["entity-store", code, details], message);
};
// A store holding one entity, and what it holds: its records and every read and find a refusal must leave as they were.
const heldState = (store, storage) => ({ records: storage.records(), bound: store.historyBound().answer, any: store.find({ kind: "any" }).answer, first: store.read({ target: { id: "e1.1" } }).answer });

test("local: a fresh write of a fitting body nesting 4000 arrays is refused as entity-too-deep, depth 4001 and limit 27, and changes nothing", () => {
	const { store, storage } = openLocal();
	assert.equal(store.create(any("held", { a: 1 }), write()).outcome, "answered");
	const before = heldState(store, storage);
	assertRefused(store.create(any("deep", deepArrays(4000)), write()), "entity-too-deep", { depth: 4001, limit: 27 }, "a create under a fresh identity");
	assert.deepEqual(heldState(store, storage), before, "no append, no position, the held entity unchanged");
	const objects = JSON.parse(`${'{"k":'.repeat(4000)}0${"}".repeat(4000)}`);
	assertRefused(store.create(any("deep-objects", objects), write()), "entity-too-deep", { depth: 4001, limit: 27 }, "4000 nested objects alike");
	assert.deepEqual(heldState(store, storage), before);
});

test("local: a new identity naming an unknown kind with a body nesting 4000 arrays is refused as unknown-kind, which comes first, and changes nothing", () => {
	const { store, storage } = openLocal();
	assert.equal(store.create(any("held", { a: 1 }), write()).outcome, "answered");
	const before = heldState(store, storage);
	assertRefused(store.create({ kind: "missing", name: "deep", tags: [], body: deepArrays(4000) }, write()), "unknown-kind", { kind: "missing" }, "an unknown kind");
	assertRefused(store.update({ target: { kind: "missing", name: "held" }, body: deepArrays(4000) }, write()), "unknown-kind", { kind: "missing" }, "an update naming an unknown kind");
	assert.deepEqual(heldState(store, storage), before, "no append, no position, the held entity unchanged");
});

test("local: an update whose resulting envelope nests 4000 arrays deep is refused as entity-too-deep, replacing or merging, and changes nothing", () => {
	const { store, storage } = openLocal();
	assert.equal(store.create(any("held", { a: 1 }), write()).outcome, "answered");
	const before = heldState(store, storage);
	assertRefused(store.update({ target: { id: "e1.1" }, body: deepArrays(4000) }, write()), "entity-too-deep", { depth: 4001, limit: 27 }, "a body replaced by 4000 arrays");
	assertRefused(store.update({ target: { id: "e1.1" }, body: { m: deepArrays(4000) } }, write()), "entity-too-deep", { depth: 4002, limit: 27 }, "a merge adding 4000 arrays under an object body");
	assert.deepEqual(heldState(store, storage), before, "no append, no position, the held entity unchanged");
});

test("local: a body both too large and nesting 4000 arrays deep is refused as entity-too-large, the earlier row of EM9, and changes nothing", () => {
	const { store, storage } = openLocal({ maxEntityBytes: 1000 });
	assert.equal(store.create(any("held", { a: 1 }), write()).outcome, "answered");
	const before = heldState(store, storage);
	const body = deepArrays(4000);
	const stamp = { at: new Date(T0).toISOString(), position: 2, writer: "alice" };
	// The envelope's canonical JSON: its names in code-point order, and no member here needs reordering within.
	const bytes = Buffer.byteLength(JSON.stringify({ body, changed: stamp, created: stamp, id: "e2.1", kind: "any", name: "big", revision: 1, tags: [] }));
	assert.ok(bytes > 1000 && bytes > 8001);
	assertRefused(store.create(any("big", body), write()), "entity-too-large", { bytes, limit: 1000 }, "too large and too deep at once");
	assert.deepEqual(heldState(store, storage), before, "no append, no position, the held entity unchanged");
});

const open = (overrides) => openEntityStore({ storage: createMemoryStoragePort(), clock: { now: () => T0 }, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS, ...overrides });
const refusedAs = (overrides, code, message) => {
	const opening = open(overrides);
	assert.equal(opening.opened, false, message);
	assert.equal(opening.refusal.code, code, message);
	assert.equal(typeof opening.refusal.message, "string");
	return opening.refusal;
};
const nestItems = (levels) => {
	let shape = {};
	for (let i = 1; i < levels; i++) shape = { items: shape };
	return { $schema: SHAPE_DIALECT_ID, ...shape };
};
const canonicalBytes = (v) => Buffer.byteLength(JSON.stringify(v));

test("local: a history bound outside 1 millisecond to 365 days is refused at opening as invalid-bound", () => {
	for (const historyMs of [1, 365 * 86_400_000]) assert.equal(open({ historyMs }).opened, true, `${historyMs} opens`);
	for (const historyMs of [0, -1, 365 * 86_400_000 + 1, 1.5, Number.NaN, "1000"]) refusedAs({ historyMs }, "invalid-bound", `${historyMs}`);
});

test("local: a largest size outside 1 to 262144 bytes is refused at opening as invalid-size: 0 and 262145 refused, 1 and 262144 opened", () => {
	for (const maxEntityBytes of [0, 262145, -1, 1.5]) refusedAs({ maxEntityBytes }, "invalid-size", `${maxEntityBytes}`);
	for (const maxEntityBytes of [1, 262144]) assert.equal(open({ maxEntityBytes }).opened, true, `${maxEntityBytes} opens`);
	const { store } = openLocal({ maxEntityBytes: 1 });
	assert.equal(store.create(any("a", 0), write()).refusal.code, "entity-too-large", "with a size of 1 no entity fits");
});

test("local: a kind whose name breaks EM1's pattern is refused at opening as invalid-kind-name", () => {
	for (const name of ["Bad", "", "a_b", "-a", "a".repeat(64)]) refusedAs({ kinds: { [name]: { $schema: SHAPE_DIALECT_ID } } }, "invalid-kind-name", JSON.stringify(name));
});

test("local: a kind whose body shape shape-check refuses is refused at opening as shape-refused, with shape-check's problems", () => {
	const refusal = refusedAs({ kinds: { k: { $schema: "urn:other" } } }, "shape-refused", "an unknown dialect");
	assert.deepEqual(refusal.details.problems, [{ pointer: "", keyword: "$schema", problem: "unknown-dialect" }]);
	const several = refusedAs({ kinds: { k: { $schema: SHAPE_DIALECT_ID, type: "nope", minLength: -1 } } }, "shape-refused", "two problems");
	assert.deepEqual(several.details.problems, [{ pointer: "", keyword: "minLength", problem: "invalid-value" }, { pointer: "", keyword: "type", problem: "invalid-value" }]);
});

test("local: a kind shape of 20 levels opens and one of 21 is refused as shape-too-deep", () => {
	assert.equal(open({ kinds: { k: nestItems(20) } }).opened, true);
	const refusal = refusedAs({ kinds: { k: nestItems(21) } }, "shape-too-deep", "21 levels");
	assert.equal(refusal.details.depth, 21);
});

test("local: a kind shape thousands of levels deep is refused as shape-too-deep before shape-check prepares it", () => {
	const items = refusedAs({ kinds: { k: nestItems(5000) } }, "shape-too-deep", "a 5000-level items chain");
	assert.deepEqual([items.details.depth, items.details.limit], [5000, 20]);
	let member = 0;
	for (let i = 0; i < 5000; i++) member = [member];
	let other = 1;
	for (let i = 0; i < 5000; i++) other = [other];
	const enumDeep = refusedAs({ kinds: { k: { $schema: SHAPE_DIALECT_ID, enum: [member, other] } } }, "shape-too-deep", "an enum of two 5000-level members");
	assert.deepEqual([enumDeep.details.depth, enumDeep.details.limit], [5002, 20]);
});

test("local: a kind shape that is not a JSON value, a cyclic one included, is a programming error: opening throws a TypeError", () => {
	const cyclic = { $schema: SHAPE_DIALECT_ID, properties: {} };
	cyclic.properties.self = cyclic;
	assert.throws(() => open({ kinds: { k: cyclic } }), TypeError);
	assert.throws(() => open({ kinds: { k: { $schema: SHAPE_DIALECT_ID, const: undefined } } }), TypeError);
});

test("local: a kind shape whose const or enum holds an integer beyond the safe range is refused as unsafe-shape", () => {
	assert.equal(open({ kinds: { k: { $schema: SHAPE_DIALECT_ID, const: 9007199254740991 } } }).opened, true);
	refusedAs({ kinds: { k: { $schema: SHAPE_DIALECT_ID, const: UNSAFE } } }, "unsafe-shape", "const");
	refusedAs({ kinds: { k: { $schema: SHAPE_DIALECT_ID, enum: [0, -UNSAFE] } } }, "unsafe-shape", "enum");
	refusedAs({ kinds: { k: { $schema: SHAPE_DIALECT_ID, properties: { a: { const: { x: [UNSAFE] } } } } } }, "unsafe-shape", "nested const");
});

test("local: a kind shape of 65536 bytes in canonical JSON opens and one of 65537 is refused as shape-too-large", () => {
	const sized = (bytes) => {
		const base = { $schema: SHAPE_DIALECT_ID, enum: [0, ""] };
		return { $schema: SHAPE_DIALECT_ID, enum: [0, "x".repeat(bytes - canonicalBytes(base))] };
	};
	assert.equal(canonicalBytes(sized(65536)), 65536);
	assert.equal(open({ kinds: { k: sized(65536) } }).opened, true);
	const refusal = refusedAs({ kinds: { k: sized(65537) } }, "shape-too-large", "65537 bytes");
	assert.deepEqual([refusal.details.bytes, refusal.details.limit], [65537, 65536]);
});

test("local: opening reasons are checked in EM10's order", () => {
	const deep = nestItems(21);
	const unsafe = { $schema: SHAPE_DIALECT_ID, const: UNSAFE };
	const large = { $schema: SHAPE_DIALECT_ID, enum: ["x".repeat(70000)] };
	refusedAs({ historyMs: 0, maxEntityBytes: 0 }, "invalid-bound", "bound before size");
	refusedAs({ maxEntityBytes: 0, kinds: { Bad: {} } }, "invalid-size", "size before kind name");
	refusedAs({ kinds: { ok: { $schema: "urn:x" }, Bad: {} } }, "invalid-kind-name", "kind name before shape, whichever kind comes first");
	refusedAs({ kinds: { a: { $schema: "urn:x" }, b: deep } }, "shape-too-deep", "depth before a refused shape");
	refusedAs({ kinds: { a: { $schema: "urn:x" }, b: unsafe } }, "shape-refused", "a refused shape before unsafe integers");
	refusedAs({ kinds: { a: unsafe, b: deep } }, "shape-too-deep", "depth before unsafe integers");
	refusedAs({ kinds: { a: large, b: unsafe } }, "unsafe-shape", "unsafe integers before size");
});

test("local: no kind is built in: a store given no kinds refuses every kind as unknown-kind", () => {
	const opening = open({ kinds: {} });
	assert.equal(opening.opened, true);
	assert.equal(opening.store.create(note("a"), write()).refusal.code, "unknown-kind");
	assert.equal(opening.store.find({ kind: "note" }).refusal.code, "unknown-kind");
});
