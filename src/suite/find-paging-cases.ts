/**
 * find-by-kind-tags, continued: a page holds entities in name order up to, and not past, 524288 bytes of
 * canonical JSON in `entries`, as of one position; `next` is the last name held when more remain (zorg's
 * target, EM10).
 */
import { answered, canonicalBytes, check, create, same, withStore, type Json } from "./suite-check.js";
import type { SuiteCase, SuiteSession } from "./suite-types.js";

const LARGEST = 262144;
const PAGE = 524288;

/** Makes an entity of kind `any` named `name` whose envelope is exactly `bytes` in canonical JSON, and returns it. */
export async function entityOfSize(s: SuiteSession, name: string, bytes: number): Promise<Json> {
	let entity = (await create(s, { kind: "any", name, tags: [], body: { pad: "" } })).entity;
	for (let i = 0; i < 6 && canonicalBytes(entity) !== bytes; i++) {
		const pad = "x".repeat(Math.max(0, entity.body.pad.length + bytes - canonicalBytes(entity)));
		entity = answered(await s.call("update", { target: { id: entity.id }, body: { pad } }), `pad ${name}`).entity;
	}
	same(canonicalBytes(entity), bytes, `the envelope of ${name} is ${bytes} bytes`);
	return entity;
}

const page = async (s: SuiteSession, input: Json): Promise<Json> => answered(await s.call("find", input), `find ${JSON.stringify(input)}`);
const names = (answer: Json): string[] => answer.entries.map((e: Json) => e.name);

export const pageCases: SuiteCase[] = [
	{
		name: "an entity of the largest size any store allows, 262144 bytes, is held alone in a page",
		run: (h) => withStore(h, { maxEntityBytes: LARGEST }, async (s) => {
			const big = await entityOfSize(s, "big", LARGEST);
			await entityOfSize(s, "big2", LARGEST);
			const first = await page(s, { kind: "any" });
			same([names(first), first.next], [["big"], "big"], "the first page holds one entity of 262144 bytes and names it as next");
			same(first.entries[0], big, "it is the entity whole");
			const second = await page(s, { kind: "any", after: first.next, asOf: first.position });
			same([names(second), second.next], [["big2"], null], "the second page holds the other");
		}),
	},
	{
		name: "a page holds entries of exactly 524288 bytes, and with one byte more holds one entity fewer",
		run: (h) => withStore(h, { maxEntityBytes: LARGEST }, async (s) => {
			await entityOfSize(s, "p1", LARGEST);
			await entityOfSize(s, "p2", PAGE - 3 - LARGEST);
			await entityOfSize(s, "p3", 300);
			const exact = await page(s, { kind: "any" });
			same(names(exact), ["p1", "p2"], "two entities whose entries are exactly 524288 bytes");
			same(canonicalBytes(exact.entries), PAGE, "the entries are 524288 bytes of canonical JSON");
			same(exact.next, "p2", "next is the last name held");
			const rest = await page(s, { kind: "any", after: exact.next, asOf: exact.position });
			same([names(rest), rest.next], [["p3"], null], "the rest, and next is null");
		}),
	},
	{
		name: "entries one byte over 524288 leave the second entity to the next page",
		run: (h) => withStore(h, { maxEntityBytes: LARGEST }, async (s) => {
			await entityOfSize(s, "p1", LARGEST);
			await entityOfSize(s, "p2", PAGE - 2 - LARGEST);
			await entityOfSize(s, "p3", 300);
			const over = await page(s, { kind: "any" });
			same([names(over), over.next], [["p1"], "p1"], "one entity, since two would make 524289 bytes");
			const rest = await page(s, { kind: "any", after: over.next, asOf: over.position });
			same([names(rest), rest.next], [["p2", "p3"], null], "the next page holds the rest");
			check(canonicalBytes(rest.entries) <= PAGE, "a page never passes 524288 bytes");
		}),
	},
	{
		name: "every page of a find answers as of the first page's position, though changes land between its pages",
		run: (h) => withStore(h, { maxEntityBytes: LARGEST }, async (s) => {
			await entityOfSize(s, "a1", LARGEST);
			await entityOfSize(s, "a2", LARGEST);
			const a3 = await entityOfSize(s, "a3", LARGEST);
			const first = await page(s, { kind: "any" });
			same([names(first), first.next], [["a1"], "a1"], "the first page");
			answered(await s.call("update", { target: { id: a3.id }, body: { pad: "changed" } }), "a change between pages");
			answered(await s.call("delete", { target: { kind: "any", name: "a2" } }), "a delete between pages");
			await create(s, { kind: "any", name: "a0", tags: [], body: 0 });
			await create(s, { kind: "any", name: "a4", tags: [], body: 0 });
			const second = await page(s, { kind: "any", after: "a1", asOf: first.position });
			same([second.position, names(second), second.next], [first.position, ["a2"], "a2"], "the second page as of the first's position still holds a2");
			const third = await page(s, { kind: "any", after: "a2", asOf: first.position });
			same([names(third), third.next], [["a3"], null], "the third page holds a3 as it was, and nothing created since");
			same(third.entries[0], a3, "a3 as of the first page's position");
			same(names(await page(s, { kind: "any" })), ["a0", "a1", "a3", "a4"], "a find as of now sees the changes");
		}),
	},
];
