/**
 * find-by-kind-tags: find every entity matching a kind and any set of tags, with the position the answer
 * reflects (zorg's target, EM2, and the store's part of EM10's `find`: pages by bytes as of one position).
 */
import { answered, create, note, refused, same, withStore, type Json } from "./suite-check.js";
import type { SuiteCase, SuiteSession } from "./suite-types.js";
import { pageCases } from "./find-paging-cases.js";

const names = (answer: Json): string[] => answer.entries.map((e: Json) => e.name);
const find = async (s: SuiteSession, input: Json): Promise<Json> => answered(await s.call("find", input), `find ${JSON.stringify(input)}`);

export const findByKindTagsCases: SuiteCase[] = [
	{
		name: "tags are a set returned in code-point order, and a key may appear in several tags",
		run: (h) => withStore(h, {}, async (s) => {
			const made = await create(s, note("alpha", ["topic:z", "topic:a", "project:x", "a0:b"]));
			same(made.entity.tags, ["a0:b", "project:x", "topic:a", "topic:z"], "tags in Unicode code-point order");
		}),
	},
	{
		name: "an entity carries at most 32 tags: 32 are accepted and 33 refused as too-many-tags",
		run: (h) => withStore(h, {}, async (s) => {
			const tags = (n: number) => Array.from({ length: n }, (_, i) => `t:v${i}`);
			same((await create(s, note("alpha", tags(32)))).entity.tags.length, 32, "32 tags");
			const refusal = refused(await s.call("create", note("beta", tags(33))), "too-many-tags", "33 tags");
			same(refusal.details, { count: 33, limit: 32 }, "the refusal names the count and the limit");
			refused(await s.call("update", { target: { id: "e1.1" }, tags: tags(33) }), "too-many-tags", "an update to 33 tags");
		}),
	},
	{
		name: "a write listing one tag twice is refused as duplicate-tag, naming it",
		run: (h) => withStore(h, {}, async (s) => {
			const refusal = refused(await s.call("create", note("alpha", ["a:b", "c:d", "a:b"])), "duplicate-tag", "a tag twice");
			same(refusal.details, { tag: "a:b" }, "the refusal names the tag");
			await create(s, note("alpha", ["a:b"]));
			refused(await s.call("update", { target: { id: "e1.1" }, tags: ["x:y", "x:y"] }), "duplicate-tag", "an update listing a tag twice");
		}),
	},
	{
		name: "a tag matches key:value with each part following the name pattern; a tag of 127 characters is accepted and 128 refused",
		run: (h) => withStore(h, {}, async (s) => {
			const longest = `${"k".repeat(63)}:${"v".repeat(63)}`;
			same((await create(s, note("alpha", [longest]))).entity.tags, [longest], "a tag of 127 characters");
			for (const bad of [`${"k".repeat(64)}:${"v".repeat(63)}`, "novalue", "Key:v", "k:", ":v", "k:v:w", "-k:v", "k:-v"]) {
				const refusal = refused(await s.call("create", note("beta", ["ok:tag", bad])), "invalid-tag", `the tag ${JSON.stringify(bad)}`);
				same(refusal.details, { tag: bad }, "the refusal names the first tag that fails");
			}
		}),
	},
	{
		name: "a find returns every entity of its kind carrying every tag it names and no other, in name order, with its position",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("delta", ["p:a", "t:x"]), { writer: "alice" });
			await create(s, note("bravo", ["p:a", "t:x", "t:y"]), { writer: "bob" });
			await create(s, note("charlie", ["p:a"]), { writer: "alice" });
			await create(s, note("alpha", ["t:x"]), { writer: "bob" });
			await create(s, { kind: "any", name: "echo", tags: ["p:a", "t:x"], body: null });
			const both = await find(s, { kind: "note", tags: ["p:a", "t:x"] });
			same([both.position, names(both), both.next], [5, ["bravo", "delta"], null], "both tags: bravo and delta");
			same(names(await find(s, { kind: "note", tags: ["t:y", "p:a", "t:x"] })), ["bravo"], "three tags");
			same(names(await find(s, { kind: "note", tags: ["t:z"] })), [], "a tag nobody carries");
			same(names(await find(s, { kind: "note" })), ["alpha", "bravo", "charlie", "delta"], "no tags: every entity of the kind");
			same(names(await find(s, { kind: "note", tags: [] })), ["alpha", "bravo", "charlie", "delta"], "an empty list of tags: every entity of the kind");
			same(names(await find(s, { kind: "any", tags: ["p:a"] })), ["echo"], "another kind's entities only in that kind");
		}),
	},
	{
		name: "a find's tags are a set: naming one twice is naming it once",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha", ["a:b"]));
			await create(s, note("beta", ["a:b", "c:d"]));
			same(await find(s, { kind: "note", tags: ["a:b", "a:b"] }), await find(s, { kind: "note", tags: ["a:b"] }), "a duplicated tag");
			same(names(await find(s, { kind: "note", tags: ["c:d", "a:b", "c:d"] })), ["beta"], "duplicates among several");
		}),
	},
	{
		name: "names are ordered by code point, and a page after a name holds the names after it",
		run: (h) => withStore(h, {}, async (s) => {
			for (const n of ["b", "a-1", "a", "a0", "10", "9"]) await create(s, note(n));
			same(names(await find(s, { kind: "note" })), ["10", "9", "a", "a-1", "a0", "b"], "code-point order");
			same(names(await find(s, { kind: "note", after: "a" })), ["a-1", "a0", "b"], "after a name held");
			same(names(await find(s, { kind: "note", after: "a00" })), ["b"], "after a name nobody holds");
			same(await find(s, { kind: "note", after: "b" }), { position: 6, entries: [], next: null }, "after the last name");
		}),
	},
	{
		name: "a find answers as of a position: 0, the current one, and one in between; below 0 and above the current one are refused",
		run: (h) => withStore(h, {}, async (s) => {
			const a = await create(s, note("alpha"));
			await s.call("update", { target: { id: "e1.1" }, body: { summary: "changed" } });
			await create(s, note("beta"));
			await s.call("delete", { target: { id: "e1.1" } });
			same(await find(s, { kind: "note", asOf: 0 }), { position: 0, entries: [], next: null }, "as of 0, the empty store");
			same(await find(s, { kind: "note", asOf: 1 }), { position: 1, entries: [a.entity], next: null }, "as of 1, alpha as created");
			same(names(await find(s, { kind: "note", asOf: 3 })), ["alpha", "beta"], "as of 3, before the delete");
			const current = await find(s, { kind: "note", asOf: 4 });
			same([current.position, names(current)], [4, ["beta"]], "as of the current position");
			same(await find(s, { kind: "note" }), current, "naming no position is as of the current one");
			same(refused(await s.call("find", { kind: "note", asOf: -1 }), "invalid-position", "below 0").details, { position: -1, current: 4 }, "below 0 names both");
			same(refused(await s.call("find", { kind: "note", asOf: 5 }), "invalid-position", "above").details, { position: 5, current: 4 }, "above the current one names both");
		}),
	},
	{
		name: "a find naming a kind the store was not given is refused as unknown-kind",
		run: (h) => withStore(h, {}, async (s) => {
			same(refused(await s.call("find", { kind: "nope" }), "unknown-kind", "unknown kind").details, { kind: "nope" }, "it names the kind");
		}),
	},
	...pageCases,
];
