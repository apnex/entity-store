/**
 * changes-since-position: every change after a position still held, once and in order, one page at a time,
 * or a plain statement that the position is no longer held (zorg's target, EM16, with EM8's bound and EM9's
 * `invalid-position` and `position-not-held`).
 *
 * Every write here is the harness's default writer's, so the cases run unchanged remotely, where the host
 * names the writer. Positions stay below 10 wherever a case sizes an envelope exactly, so every envelope it
 * predicts writes its positions in one digit.
 */
import { answered, canonicalBytes, check, create, iso, refused, same, T0, withStore, type Json } from "./suite-check.js";
import type { SuiteCase, SuiteSession } from "./suite-types.js";

const LARGEST = 262144;
const PAGE = 524288;

const page = async (s: SuiteSession, since: number, message = `changes since ${since}`): Promise<Json> => answered(await s.call("changes", { since }), message);

/** The position of the change an item belongs to: an envelope's `changed`, or a delete's own `position`. */
const positionOf = (item: Json): number => ("deleted" in item ? item.position : item.changed.position);

const ENVELOPE_FIELDS = ["body", "changed", "created", "id", "kind", "name", "revision", "tags"];
const DELETED_FIELDS = ["at", "deleted", "position", "writer"];

/**
 * A string whose canonical JSON, quotes included, is exactly `bytes` long in UTF-8, beginning with characters
 * of two, three and four UTF-8 bytes and characters JSON escapes, so a page counted in string length or
 * without escapes would hold a different set of changes.
 */
const PAD_PREFIX = "\u00e9\u20ac\u{1F600}\n\"\\\u0001";
export function padOf(bytes: number): string {
	const fixed = canonicalBytes(PAD_PREFIX);
	check(bytes >= fixed, `a pad of ${bytes} bytes holds its prefix`);
	return PAD_PREFIX + "x".repeat(bytes - fixed);
}

/**
 * Creates a probe entity of kind `any` named `p0` with an empty pad, and returns a function that creates an
 * entity named with two characters whose envelope is exactly `bytes` in canonical JSON: an envelope differs
 * from the probe's only in its pad while its name is two characters, its positions one digit and the clock
 * unmoved.
 */
async function sizer(s: SuiteSession): Promise<(name: string, bytes: number) => Promise<Json>> {
	const probe = (await create(s, { kind: "any", name: "p0", tags: [], body: { pad: "" } })).entity;
	const base = canonicalBytes(probe) - canonicalBytes("");
	return async (name, bytes) => {
		check(name.length === 2, "a sized entity's name is two characters");
		const entity = (await create(s, { kind: "any", name, tags: [], body: { pad: padOf(bytes - base) } })).entity;
		same(canonicalBytes(entity), bytes, `the envelope of ${name} is ${bytes} bytes`);
		check(entity.created.position < 10, "a sized entity's position is one digit");
		return entity;
	};
}

const nestArrays = (levels: number): Json => {
	let v: Json = "core";
	for (let i = 0; i < levels; i++) v = [v];
	return v;
};

export const changesSincePositionCases: SuiteCase[] = [
	{
		name: "an empty store answers since 0 with no items and next null, and any store answers since its own position so, however long since its latest change",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			same(await page(s, 0), { position: 0, changes: [], next: null }, "an empty store since 0");
			await create(s, { kind: "note", name: "alpha", tags: [], body: { pointer: "https://example.com/alpha", summary: "about alpha" } });
			s.setTime(T0 + 2 * 365 * 86_400_000);
			same(await page(s, 1), { position: 1, changes: [], next: null }, "since the store's own position, two years on");
		}),
	},
	{
		name: "a create, an update and a delete each give exactly their item, in position order, with no write identity, digest or answer",
		run: (h) => withStore(h, {}, async (s) => {
			const created = (await create(s, { kind: "note", name: "alpha", tags: ["topic:a"], body: { pointer: "https://example.com/alpha", summary: "about alpha" } })).entity;
			s.setTime(T0 + 10);
			const updated = answered(await s.call("update", { target: { id: created.id }, name: "beta", tags: ["topic:b"] }), "update").entity;
			s.setTime(T0 + 20);
			const deleted = answered(await s.call("delete", { target: { kind: "note", name: "beta" } }), "delete");
			const writer = created.created.writer;
			const deleteItem = { deleted: { id: created.id, kind: "note", name: "beta", revision: 3 }, position: 3, at: iso(T0 + 20), writer };
			same(deleted.deleted, deleteItem.deleted, "the delete item's deleted holds what the delete's answer holds");
			const all = await page(s, 0);
			same(all, { position: 3, changes: [created, updated, deleteItem], next: null }, "every item since 0");
			same([created.created.position, created.changed.position], [1, 1], "a create is the item whose created and changed name the same position");
			check(updated.created.position !== updated.changed.position, "an update's created and changed name different positions");
			same(Object.keys(all.changes[0]).sort(), ENVELOPE_FIELDS, "a create's item is exactly an envelope");
			same(Object.keys(all.changes[1]).sort(), ENVELOPE_FIELDS, "an update's item is exactly an envelope");
			same(Object.keys(all.changes[2]).sort(), DELETED_FIELDS, "a delete's item holds exactly deleted, position, at and writer");
			same(Object.keys(all.changes[2].deleted).sort(), ["id", "kind", "name", "revision"], "a delete's deleted holds exactly id, kind, name and revision");
			same(await page(s, 1), { position: 3, changes: [updated, deleteItem], next: null }, "since 1, between");
			same(await page(s, 2), { position: 3, changes: [deleteItem], next: null }, "since 2, between");
			same(await page(s, 3), { position: 3, changes: [], next: null }, "since the store's position");
		}),
	},
	{
		name: "since below 0 or above the store's position is refused as invalid-position with exactly position and current",
		run: (h) => withStore(h, {}, async (s) => {
			same(refused(await s.call("changes", { since: 1 }), "invalid-position", "since 1 on an empty store").details, { position: 1, current: 0 }, "above an empty store's position");
			await create(s, { kind: "any", name: "alpha", tags: [], body: 0 });
			same(refused(await s.call("changes", { since: -1 }), "invalid-position", "since -1").details, { position: -1, current: 1 }, "below 0");
			same(refused(await s.call("changes", { since: 2 }), "invalid-position", "since 2").details, { position: 2, current: 1 }, "above the store's position");
		}),
	},
	{
		name: "a position whose first following change is one millisecond inside the bound is answered, and exactly at it refused as position-not-held with exactly position, before and after a restart and with the clock set back",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			const first = (await create(s, { kind: "any", name: "alpha", tags: [], body: 0 })).entity;
			s.setTime(T0 + 500);
			const second = (await create(s, { kind: "any", name: "beta", tags: [], body: 0 })).entity;
			s.setTime(T0 + 999);
			same((await page(s, 0, "since 0, 1 ms inside")).changes, [first, second], "since 0 is held one millisecond inside the bound");
			s.setTime(T0 + 1000);
			same(refused(await s.call("changes", { since: 0 }), "position-not-held", "since 0 at the bound").details, { position: 0 }, "refused exactly at the bound, naming the position");
			same((await page(s, 1, "since 1 at 1000")).changes, [second], "since 1 is held: the change after it, at 500, is within the bound");
			await s.restart();
			refused(await s.call("changes", { since: 0 }), "position-not-held", "since 0 after a restart");
			s.setTime(T0 + 10);
			refused(await s.call("changes", { since: 0 }), "position-not-held", "since 0 with the clock set back");
			same((await page(s, 1, "since 1 with the clock set back")).changes, [second], "since 1 still held");
			s.setTime(T0 + 1500);
			same(refused(await s.call("changes", { since: 1 }), "position-not-held", "since 1 at its bound").details, { position: 1 }, "since 1 at its bound");
			same(await page(s, 2, "since the store's position"), { position: 2, changes: [], next: null }, "the store's own position stays held");
		}),
	},
	{
		name: "the items since a position are the same after a restart as before it",
		run: (h) => withStore(h, {}, async (s) => {
			const made = (await create(s, { kind: "note", name: "alpha", tags: [], body: { pointer: "https://example.com/alpha", summary: "about alpha" } })).entity;
			s.setTime(T0 + 5);
			answered(await s.call("update", { target: { id: made.id }, body: { summary: "changed" } }), "update");
			s.setTime(T0 + 9);
			answered(await s.call("delete", { target: { id: made.id } }), "delete");
			const before = await page(s, 0, "before the restart");
			await s.restart();
			same(await page(s, 0, "after the restart"), before, "the same page after a restart");
			same((await page(s, 2, "since 2 after the restart")).changes, before.changes.slice(2), "and since a position between");
		}),
	},
	{
		name: "the item of a delete names the entity as the delete found it, after a rename, and the revision the delete gave it",
		run: (h) => withStore(h, {}, async (s) => {
			const made = (await create(s, { kind: "any", name: "alpha", tags: [], body: 0 })).entity;
			answered(await s.call("update", { target: { id: made.id }, name: "gamma" }), "rename");
			answered(await s.call("delete", { target: { id: made.id } }), "delete");
			const item = (await page(s, 2)).changes[0];
			same(item.deleted, { id: made.id, kind: "any", name: "gamma", revision: 3 }, "the delete found it named gamma at revision 2, and gave it revision 3");
			same([item.position, item.writer], [3, made.created.writer], "the change's position and writer");
		}),
	},
	{
		name: "a page holds items of exactly 524288 bytes of canonical JSON, brackets and commas counted, with characters of several UTF-8 bytes and escapes, and answers a position above its next",
		run: (h) => withStore(h, { maxEntityBytes: LARGEST }, async (s) => {
			const sized = await sizer(s);
			const p1 = await sized("p1", LARGEST);
			const p2 = await sized("p2", PAGE - 3 - LARGEST);
			const p3 = await sized("p3", 300);
			const exact = await page(s, 1);
			same(exact.changes, [p1, p2], "two items whose array is exactly 524288 bytes");
			same(canonicalBytes(exact.changes), PAGE, "the page's changes are 524288 bytes of canonical JSON");
			same([exact.position, exact.next], [4, 3], "next is the last change held, below the store's position");
			same(await page(s, exact.next), { position: 4, changes: [p3], next: null }, "the rest, and next is null");
		}),
	},
	{
		name: "items one byte over 524288 leave the second change to the next page",
		run: (h) => withStore(h, { maxEntityBytes: LARGEST }, async (s) => {
			const sized = await sizer(s);
			const p1 = await sized("p1", LARGEST);
			const p2 = await sized("p2", PAGE - 2 - LARGEST);
			const p3 = await sized("p3", 300);
			const over = await page(s, 1);
			same([over.changes, over.position, over.next], [[p1], 4, 2], "one change, since two would make 524289 bytes");
			const rest = await page(s, over.next);
			same([rest.changes, rest.next], [[p2, p3], null], "the next page holds the rest");
			check(canonicalBytes(rest.changes) <= PAGE, "a page never passes 524288 bytes");
		}),
	},
	{
		name: "asked from each next until null, three pages give every item once and in order, changes landing between pages included, each page answering the store's position",
		run: (h) => withStore(h, { maxEntityBytes: LARGEST }, async (s) => {
			const sized = await sizer(s);
			await sized("a1", LARGEST);
			await sized("a2", LARGEST);
			await sized("a3", LARGEST);
			const first = await page(s, 0);
			same([first.changes.map(positionOf), first.position, first.next], [[1, 2], 4, 2], "the first page: the probe and a1");
			answered(await s.call("update", { target: { kind: "any", name: "p0" }, body: { pad: "changed" } }), "a change between pages");
			answered(await s.call("delete", { target: { kind: "any", name: "a1" } }), "a delete between pages");
			const second = await page(s, first.next);
			same([second.changes.map(positionOf), second.position, second.next], [[3], 6, 3], "the second page: a2, answering the store's new position");
			const third = await page(s, second.next);
			same([third.changes.map(positionOf), third.position, third.next], [[4, 5, 6], 6, null], "the third page: a3 and the changes made between pages");
			same([...first.changes, ...second.changes, ...third.changes].map(positionOf), [1, 2, 3, 4, 5, 6], "every item once, in order");
		}),
	},
	{
		name: "an envelope of 27 levels is given whole as an item",
		run: (h) => withStore(h, {}, async (s) => {
			const made = (await create(s, { kind: "any", name: "deep", tags: [], body: nestArrays(26) })).entity;
			same((await page(s, 0)).changes, [made], "the envelope of 27 levels, whole");
		}),
	},
];
