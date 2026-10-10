/**
 * store-refusal: a refusal says, in the shared refusal form, what was wrong and how to fix it (zorg's
 * target, EM9: the record, its `details`, truncation, the order of the store's rows, and E11's cases).
 */
import { answered, create, note, positionOf, refused, same, T0, withStore, type Json } from "./suite-check.js";
import type { SuiteCase, SuiteSession } from "./suite-types.js";
import { entityOfSize } from "./find-paging-cases.js";

const long = (n: number, c = "a") => c.repeat(n);

/** Calls and expects a refusal with its details, returning the record. */
async function expectRefusal(s: SuiteSession, op: Json, input: Json, code: string, details: Json, caller?: Json): Promise<Json> {
	const refusal = refused(await s.call(op, input, caller), code, `${op} refused as ${code}`);
	same(refusal.details, details, `${code}'s details`);
	return refusal;
}

export const storeRefusalCases: SuiteCase[] = [
	{
		name: "each of the store's codes gives a record of exactly EM9's fields with the details its row names, and none takes a position",
		run: (h) => withStore(h, { historyMs: 1000, maxEntityBytes: 1000 }, async (s) => {
			await create(s, note("alpha"));
			await create(s, note("beta"));
			s.setTime(T0 + 2000);
			await create(s, { kind: "any", name: "small", tags: [], body: 0 });
			const p = await positionOf(s);
			// alpha's identity is outside the bound by now, so identity-reused is shown with one still retained.
			const retained = s.newWriteId();
			await create(s, note("gamma"), { writeId: retained });
			await expectRefusal(s, "create", note("other"), "identity-reused", { writeId: retained }, { writeId: retained });
			await expectRefusal(s, "create", { kind: "nope", name: "x", tags: [], body: 0 }, "unknown-kind", { kind: "nope" });
			await expectRefusal(s, "find", { kind: "note", asOf: 99 }, "invalid-position", { position: 99, current: p + 1 });
			await expectRefusal(s, "find", { kind: "note", asOf: 0 }, "position-not-held", { position: 0 });
			await expectRefusal(s, "update", { target: { kind: "note" }, name: "x" }, "invalid-target", {});
			await expectRefusal(s, "update", { target: { id: "e1.1" } }, "empty-update", {});
			await expectRefusal(s, "delete", { target: { kind: "note", name: "zed" } }, "not-found", { target: { kind: "note", name: "zed" } });
			await expectRefusal(s, "update", { target: { id: "e1.1" }, expectedRevision: 2, tags: [] }, "revision-moved", { expected: 2, current: 1 });
			await expectRefusal(s, "update", { target: { id: "e1.1" }, name: "Bad" }, "invalid-name", { name: "Bad" });
			await expectRefusal(s, "update", { target: { id: "e1.1" }, name: "beta" }, "name-taken", { kind: "note", name: "beta", id: "e2.1" });
			await expectRefusal(s, "update", { target: { id: "e1.1" }, tags: Array.from({ length: 40 }, (_, i) => `k:v${i}`) }, "too-many-tags", { count: 40, limit: 32 });
			await expectRefusal(s, "update", { target: { id: "e1.1" }, tags: ["a:b", "nope"] }, "invalid-tag", { tag: "nope" });
			await expectRefusal(s, "update", { target: { id: "e1.1" }, tags: ["a:b", "a:b"] }, "duplicate-tag", { tag: "a:b" });
			const misfit = await expectRefusal(s, "update", { target: { id: "e1.1" }, body: { summary: "" } }, "misfit", {});
			same(misfit.misfits, [{ pointer: "/summary", keyword: "minLength", expected: 1, fit: "a string of length at least 1" }], "the misfit, judged after the update is applied, pointing into the body");
			const big = refused(await s.call("update", { target: { kind: "any", name: "small" }, body: long(2000) }), "entity-too-large", "too large");
			same([Object.keys(big.details).sort(), big.details.limit, big.details.bytes > 2000], [["bytes", "limit"], 1000, true], "entity-too-large names the bytes and the limit");
			let deep: Json = 0;
			for (let i = 0; i < 27; i++) deep = [deep];
			await expectRefusal(s, "update", { target: { kind: "any", name: "small" }, body: deep }, "entity-too-deep", { depth: 28, limit: 27 });
			same(await positionOf(s), p + 1, "no refusal took a position");
		}),
	},
	{
		name: "a string details takes from an input is cut to its first 128 code points, with truncated true, and what, why and fix never repeat it",
		run: (h) => withStore(h, {}, async (s) => {
			const r200 = await expectRefusal(s, "create", note(long(200, "n")), "invalid-name", { name: long(128, "n"), truncated: true });
			for (const f of ["what", "why", "fix"]) same(r200[f].includes(long(129, "n")), false, `${f} does not repeat the input`);
			await expectRefusal(s, "create", note(long(128, "n").replace(/^n/, "N")), "invalid-name", { name: long(128, "n").replace(/^n/, "N") });
			await expectRefusal(s, "create", note(long(129, "n")), "invalid-name", { name: long(128, "n"), truncated: true });
			const astral = "\u{1F600}".repeat(130);
			await expectRefusal(s, "create", note(astral), "invalid-name", { name: "\u{1F600}".repeat(128), truncated: true });
			await expectRefusal(s, "create", { kind: long(200, "k"), name: "x", tags: [], body: 0 }, "unknown-kind", { kind: long(128, "k"), truncated: true });
			await expectRefusal(s, "update", { target: { id: long(200, "i") }, tags: [] }, "not-found", { target: { id: long(128, "i") }, truncated: true });
			await expectRefusal(s, "create", note("alpha", [long(300, "t")]), "invalid-tag", { tag: long(128, "t"), truncated: true });
		}),
	},
	{
		name: "E11's cases: names of 63 and 64 characters, tags of 127 and 128, an unknown kind, a target of 200 characters, and a reused identity with an over-long name",
		run: (h) => withStore(h, {}, async (s) => {
			same((await create(s, note(long(63)))).entity.name, long(63), "a name of 63 characters is accepted");
			await expectRefusal(s, "create", note(long(64)), "invalid-name", { name: long(64) });
			const tag127 = `${long(63, "k")}:${long(63, "v")}`;
			same((await create(s, note("tags", [tag127]))).entity.tags, [tag127], "a tag of 127 characters is accepted");
			await expectRefusal(s, "create", note("tags2", [`${tag127}v`]), "invalid-tag", { tag: `${tag127}v` });
			await expectRefusal(s, "create", { kind: "unknown", name: "x", tags: [], body: 0 }, "unknown-kind", { kind: "unknown" });
			const target = { kind: "note", name: long(200) };
			same(answered(await s.call("read", { target }), "read of a 200-character name").entity, null, "a read of a 200-character target answers null");
			await expectRefusal(s, "update", { target, tags: [] }, "not-found", { target: { kind: "note", name: long(128) }, truncated: true });
			await expectRefusal(s, "delete", { target: { id: long(200, "e") } }, "not-found", { target: { id: long(128, "e") }, truncated: true });
			const writeId = s.newWriteId();
			await create(s, note("first"), { writeId });
			await expectRefusal(s, "create", note(long(300)), "identity-reused", { writeId }, { writeId });
		}),
	},
	{
		name: "a write failing several rows is refused at the first in EM9's order, the first failing tag named, and always the same way",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			await create(s, note("beta"));
			const cases: [string, Json, string][] = [
				["create", { kind: "nope", name: "BAD", tags: ["bad"], body: 0 }, "unknown-kind"],
				["update", { target: { kind: "nope", name: "alpha" } }, "unknown-kind"],
				["update", { target: { id: "e1.1", kind: "note" } }, "invalid-target"],
				["update", { target: { id: "e9.1" } }, "empty-update"],
				["update", { target: { id: "e9.1" }, expectedRevision: 5, name: "BAD" }, "not-found"],
				["update", { target: { id: "e1.1" }, expectedRevision: 5, name: "BAD" }, "revision-moved"],
				["update", { target: { id: "e1.1" }, name: "BAD", tags: ["bad"] }, "invalid-name"],
				["update", { target: { id: "e1.1" }, name: "beta", tags: ["bad"] }, "name-taken"],
				["create", note("gamma", [...Array.from({ length: 33 }, (_, i) => `k:v${i}`), "bad"]), "too-many-tags"],
				["create", note("gamma", ["a:b", "a:b", "bad", "worse"]), "invalid-tag"],
				["create", note("gamma", ["x:y", "a:b", "x:y", "a:b"]), "duplicate-tag"],
				["create", { kind: "note", name: "gamma", tags: [], body: { summary: "" } }, "misfit"],
			];
			for (const [op, input, code] of cases) {
				const first = refused(await s.call(op as Json, input), code, `${op} ${JSON.stringify(input).slice(0, 60)}`);
				same(refused(await s.call(op as Json, input), code, "again"), first, "the same write gets the same refusal");
				if (code === "invalid-tag") same(first.details, { tag: "bad" }, "the first tag that fails is named");
				if (code === "duplicate-tag") same(first.details, { tag: "x:y" }, "the first repeated tag is named");
			}
			same(await positionOf(s), 2, "no refusal took a position");
		}),
	},
	{
		name: "a misfit carries shape-check's records unchanged, every misfit in SD5's order, pointing into the body",
		run: (h) => withStore(h, {}, async (s) => {
			const refusal = refused(await s.call("create", { kind: "note", name: "alpha", tags: [], body: { z: 1, summary: 5, pointer: "not a uri" } }), "misfit", "a body with three misfits");
			same(refusal.details, {}, "misfit names no details");
			same(refusal.misfits, [
				{ pointer: "/pointer", keyword: "format", expected: "uri", fit: "an absolute URI, such as https://example.com/page" },
				{ pointer: "/summary", keyword: "type", expected: "string", fit: "a value of type string" },
				{ pointer: "/z", keyword: "additionalProperties", expected: false, fit: "no property named \"z\"" },
			], "the records, in order");
			const missing = refused(await s.call("create", { kind: "note", name: "alpha", tags: [], body: {} }), "misfit", "an empty body");
			same(missing.misfits.map((m: Json) => [m.pointer, m.keyword]), [["/pointer", "required"], ["/summary", "required"]], "each missing property");
		}),
	},
	{
		name: "an entity of exactly the largest size is accepted and one byte over is refused as entity-too-large",
		run: (h) => withStore(h, { maxEntityBytes: 262144 }, async (s) => {
			const exact = await entityOfSize(s, "exact", 262144);
			const over = refused(await s.call("update", { target: { id: exact.id }, body: { pad: `${exact.body.pad}x` } }), "entity-too-large", "one byte over");
			same(over.details, { bytes: 262145, limit: 262144 }, "it names the bytes and the limit");
		}),
	},
];
