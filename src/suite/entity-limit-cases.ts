/**
 * store-refusal, continued: the limits the store holds on the envelope a write would leave - 27 levels
 * and integers AGP can carry - and bodies of any JSON value their kind admits (zorg's target, EM9, EM10).
 * Integers beyond the safe range cannot cross AGP in a request, so their refusal is a local case.
 */
import { answered, create, read, refused, same, withStore, type Json } from "./suite-check.js";
import type { SuiteCase } from "./suite-types.js";

const nestArrays = (levels: number): Json => {
	let v: Json = "core";
	for (let i = 0; i < levels; i++) v = [v];
	return v;
};
const nestObjects = (levels: number): Json => {
	let v: Json = "core";
	for (let i = 0; i < levels; i++) v = { n: v };
	return v;
};

export const entityLimitCases: SuiteCase[] = [
	{
		name: "an envelope of 27 levels is created, updated, read and found, and one of 28 is refused as entity-too-deep",
		run: (h) => withStore(h, {}, async (s) => {
			const made = await create(s, { kind: "any", name: "deep", tags: [], body: nestArrays(26) });
			same(made.entity.body, nestArrays(26), "a body of 26 nested arrays makes an envelope of 27 levels");
			const updated = answered(await s.call("update", { target: { id: made.entity.id }, body: nestObjects(26) }), "update to 26 nested objects");
			same((await read(s, { id: made.entity.id })).entity, updated.entity, "read whole");
			same(answered(await s.call("find", { kind: "any" }), "find").entries, [updated.entity], "found whole");
			same(refused(await s.call("create", { kind: "any", name: "deeper", tags: [], body: nestArrays(27) }), "entity-too-deep", "27 nested arrays").details, { depth: 28, limit: 27 }, "a body of 27 nested arrays is refused");
			same(refused(await s.call("update", { target: { id: made.entity.id }, body: nestObjects(27) }), "entity-too-deep", "update to 27 nested objects").details, { depth: 28, limit: 27 }, "an update to 28 levels is refused");
			same(refused(await s.call("update", { target: { id: made.entity.id }, body: { m: nestObjects(26) } }), "entity-too-deep", "a merge reaching 28 levels").details, { depth: 28, limit: 27 }, "the envelope the update would leave is measured");
		}),
	},
	{
		name: "integers 9007199254740991 from zero, at the top of a body and nested in its objects and arrays, are created, read and found",
		run: (h) => withStore(h, {}, async (s) => {
			const bodies: Json[] = [9007199254740991, -9007199254740991, { a: { b: 9007199254740991 } }, [0, [-9007199254740991]], { list: [{ n: 9007199254740991 }] }];
			for (const [i, body] of bodies.entries()) {
				const made = await create(s, { kind: "any", name: `n${i}`, tags: [], body });
				same(made.entity.body, body, `body ${i} kept exactly`);
				same((await read(s, { id: made.entity.id })).entity.body, body, `body ${i} read exactly`);
			}
			same(answered(await s.call("find", { kind: "any" }), "find").entries.map((e: Json) => e.body), bodies, "found exactly");
		}),
	},
	{
		name: "a body may be any JSON value its kind admits: strings and arrays as well as objects, judged after an update is applied",
		run: (h) => withStore(h, {}, async (s) => {
			const text = await create(s, { kind: "text", name: "t", tags: [], body: "hello" });
			same(text.entity.body, "hello", "a string body");
			same(answered(await s.call("update", { target: { id: text.entity.id }, body: "bye" }), "update").entity.body, "bye", "a string body replaced whole");
			same(refused(await s.call("update", { target: { id: text.entity.id }, body: 5 }), "misfit", "a number for a string kind").misfits, [{ pointer: "", keyword: "type", expected: "string", fit: "a value of type string" }], "the misfit points at the body itself");
			const list = await create(s, { kind: "list", name: "l", tags: [], body: ["a", "b"] });
			same(list.entity.body, ["a", "b"], "an array body");
			same(refused(await s.call("create", { kind: "list", name: "l2", tags: [], body: ["a", 1] }), "misfit", "a number in a list of strings").misfits, [{ pointer: "/1", keyword: "type", expected: "string", fit: "a value of type string" }], "the misfit points into the array");
			same(answered(await s.call("update", { target: { id: list.entity.id }, body: [] }), "empty list").entity.body, [], "an array replaced whole");
			for (const [i, body] of [null, true, 0, 1.5, "s", {}].entries()) same((await create(s, { kind: "any", name: `a${i}`, tags: [], body })).entity.body, body, `the body ${JSON.stringify(body)}`);
		}),
	},
];
