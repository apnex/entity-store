/**
 * follow-narrowed-set: changes since a position, narrowed by kind and tags, each write reported as its entity
 * entering, changing within or leaving the set (zorg's target, EM17, with EM8's bound and EM9's `unknown-kind`,
 * `invalid-position` and `position-not-held`).
 *
 * Every case follows pages from a position until `through` reaches the `position` a page answers, and judges
 * only the items and `through` across the pages, so a harness reaching the store remotely may give the items in
 * pages of its own; and every input keeps within the shape entity-api serves `follow` under - a kind of at most
 * 63 characters, at most 32 tags of at most 127 characters - so the cases run unchanged remotely. The exact pages,
 * inputs beyond that shape, programming errors and `waitForChange` are entity-store's own tests. Every write is
 * the harness's default writer's, as the host names it remotely.
 */
import { answered, check, create, iso, note, positionOf, refused, same, T0, withStore, type Json } from "./suite-check.js";
import type { SuiteCase, SuiteSession } from "./suite-types.js";

/** Every item a follow gives from `since`, across its pages, and the `through` and `position` of the last page. */
export async function followAll(s: SuiteSession, input: Json, message: string): Promise<{ items: Json[]; through: number; position: number }> {
	const items: Json[] = [];
	let since: number = input.since;
	for (let pages = 0; pages < 10_000; pages++) {
		const page = answered(await s.call("follow", { ...input, since }), `${message}: follow since ${since}`);
		same(Object.keys(page).sort(), ["changes", "position", "through"], `${message}: a page holds exactly position, through and changes`);
		check(Number.isSafeInteger(page.through) && page.through >= since && page.through <= page.position, `${message}: through ${page.through} lies from since ${since} to the page's position ${page.position}`);
		check(page.through > since || since === page.position, `${message}: a page from below the position takes at least one change`);
		items.push(...page.changes);
		if (page.through === page.position) return { items, through: page.through, position: page.position };
		since = page.through;
	}
	throw new Error(`${message}: the follow never reached the store's position`);
}

/** The item a follow gives for a write: its event, the change's stamp, the entity's identity and the envelope or null. */
function item(event: string, stamp: Json, id: string, entity: Json | null): Json {
	return { event, position: stamp.position, at: stamp.at, writer: stamp.writer, id, entity };
}

const nestArrays = (levels: number): Json => {
	let v: Json = "core";
	for (let i = 0; i < levels; i++) v = [v];
	return v;
};

/** An update that must be answered. */
const update = async (s: SuiteSession, input: Json): Promise<Json> => answered(await s.call("update", input), `update ${JSON.stringify(input).slice(0, 80)}`);

/** A delete that must be answered. */
const remove = async (s: SuiteSession, input: Json): Promise<Json> => answered(await s.call("delete", input), `delete ${JSON.stringify(input).slice(0, 80)}`);

export const followNarrowedSetCases: SuiteCase[] = [
	{
		name: "a create into the set enters it; a create, an update and a delete outside the set before and after give nothing, nor do entities of another kind, and through still reaches the store's position",
		run: (h) => withStore(h, {}, async (s) => {
			const inside = (await create(s, note("alpha", ["topic:a", "team:x"]))).entity;
			const outside = (await create(s, note("beta", ["topic:b"]))).entity;
			s.setTime(T0 + 10);
			await update(s, { target: { id: outside.id }, body: { summary: "still outside" } });
			await create(s, { kind: "any", name: "alpha", tags: ["topic:a"], body: 1 });
			await remove(s, { target: { id: outside.id } });
			const followed = await followAll(s, { kind: "note", tags: ["topic:a"], since: 0 }, "the set of topic:a");
			same(followed.items, [item("entering", inside.created, inside.id, inside)], "only the create into the set, entering it");
			same(followed.through, 5, "through reaches the store's position over the changes that give nothing");
			same(followed.position, 5, "the store's position");
		}),
	},
	{
		name: "an update within the set and a rename are changing; a retag out of the set is leaving and back is entering; a delete is leaving, its entity null; each item exactly",
		run: (h) => withStore(h, {}, async (s) => {
			const made = (await create(s, note("alpha", ["topic:a"]))).entity;
			s.setTime(T0 + 10);
			const updated = (await update(s, { target: { id: made.id }, body: { summary: "changed within" } })).entity;
			s.setTime(T0 + 20);
			const renamed = (await update(s, { target: { id: made.id }, name: "gamma" })).entity;
			s.setTime(T0 + 30);
			const out = (await update(s, { target: { id: made.id }, tags: ["topic:b"] })).entity;
			s.setTime(T0 + 40);
			const back = (await update(s, { target: { id: made.id }, tags: ["topic:a", "topic:b"] })).entity;
			s.setTime(T0 + 50);
			const deleted = await remove(s, { target: { kind: "note", name: "gamma" } });
			const writer = made.created.writer;
			const followed = await followAll(s, { kind: "note", tags: ["topic:a"], since: 0 }, "the set of topic:a");
			same(followed.items, [
				item("entering", made.created, made.id, made),
				item("changing", updated.changed, made.id, updated),
				item("changing", renamed.changed, made.id, renamed),
				item("leaving", out.changed, made.id, out),
				item("entering", back.changed, made.id, back),
				item("leaving", { position: deleted.position, at: iso(T0 + 50), writer }, made.id, null),
			], "each write's event, with the envelope the change left or null");
			for (const given of followed.items) same(Object.keys(given).sort(), ["at", "entity", "event", "id", "position", "writer"], "an item holds exactly its fields");
		}),
	},
	{
		name: "a follow naming no tags follows every entity of the kind; a tag named twice is named once; a tag no entity carries matches nothing while through advances; 32 tags are a set like any other",
		run: (h) => withStore(h, {}, async (s) => {
			const a = (await create(s, note("alpha", ["topic:a"]))).entity;
			const b = (await create(s, note("beta", []))).entity;
			await create(s, { kind: "any", name: "other", tags: [], body: null });
			const all = await followAll(s, { kind: "note", since: 0 }, "no tags");
			same(all.items, [item("entering", a.created, a.id, a), item("entering", b.created, b.id, b)], "every note, and no entity of another kind");
			const twice = await followAll(s, { kind: "note", tags: ["topic:a", "topic:a"], since: 0 }, "a tag named twice");
			same(twice.items, [item("entering", a.created, a.id, a)], "a tag named twice is named once");
			const none = await followAll(s, { kind: "note", tags: ["topic:nothing"], since: 0 }, "a tag no entity carries");
			same([none.items, none.through], [[], 3], "nothing, and through at the store's position");
			const many = Array.from({ length: 32 }, (_, i) => `k${i}:v`);
			const full = (await create(s, note("full", many))).entity;
			const thirtyTwo = await followAll(s, { kind: "note", tags: [...many].reverse(), since: 3 }, "32 tags");
			same(thirtyTwo.items, [item("entering", full.created, full.id, full)], "an entity carrying all 32 enters the set of 32");
		}),
	},
	{
		name: "an entity is in the set only while it carries every tag named: carrying one of two gives nothing, gaining the other enters, keeping both is changing, and losing either leaves",
		run: (h) => withStore(h, {}, async (s) => {
			const tags = ["topic:a", "team:x"];
			const made = (await create(s, note("alpha", ["topic:a"]))).entity;
			const both = (await update(s, { target: { id: made.id }, tags: ["topic:a", "team:x", "extra:y"] })).entity;
			const kept = (await update(s, { target: { id: made.id }, tags: ["team:x", "topic:a"] })).entity;
			const lostOne = (await update(s, { target: { id: made.id }, tags: ["topic:a"] })).entity;
			const again = (await update(s, { target: { id: made.id }, tags: ["topic:a", "team:x"] })).entity;
			const lostOther = (await update(s, { target: { id: made.id }, tags: ["team:x"] })).entity;
			const followed = await followAll(s, { kind: "note", tags, since: 0 }, "two tags");
			same(followed.items, [
				item("entering", both.changed, made.id, both),
				item("changing", kept.changed, made.id, kept),
				item("leaving", lostOne.changed, made.id, lostOne),
				item("entering", again.changed, made.id, again),
				item("leaving", lostOther.changed, made.id, lostOther),
			], "the create carrying one tag gives nothing; then entering, changing and leaving by each tag lost");
		}),
	},
	{
		name: "items are given across pages once and in order, changes made between pages and changes outside the set included",
		run: (h) => withStore(h, { maxEntityBytes: 262_144 }, async (s) => {
			const big = (name: string, tags: string[]): Json => ({ kind: "any", name, tags, body: { pad: "x".repeat(200_000) } });
			const expected: Json[] = [];
			for (let i = 0; i < 5; i++) {
				const made = (await create(s, big(`in-${i}`, ["set:yes"]))).entity;
				expected.push(item("entering", made.created, made.id, made));
				await create(s, big(`out-${i}`, ["set:no"]));
			}
			const items: Json[] = [];
			let since = 0;
			let pages = 0;
			for (;;) {
				const page = answered(await s.call("follow", { kind: "any", tags: ["set:yes"], since }), `follow since ${since}`);
				items.push(...page.changes);
				pages++;
				if (pages === 1) {
					// A change in the set and one outside it, made between pages.
					const later = (await create(s, big("in-later", ["set:yes"]))).entity;
					expected.push(item("entering", later.created, later.id, later));
					await create(s, big("out-later", ["set:no"]));
				}
				const position = await positionOf(s);
				if (page.through === position) break;
				since = page.through;
			}
			same(items, expected, "every item once, in order");
		}),
	},
	{
		name: "an unknown kind is refused before a since that is also refused; a since below 0 or above the store's position is refused invalid-position; a since at the position answers no items and through equal to it",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha", ["topic:a"]));
			const unknown = refused(await s.call("follow", { kind: "nothing", since: -1 }), "unknown-kind", "an unknown kind and a since below 0");
			same(unknown.details, { kind: "nothing" }, "unknown-kind names the kind");
			for (const since of [-1, 2]) {
				const invalid = refused(await s.call("follow", { kind: "note", since }), "invalid-position", `since ${since}`);
				same(invalid.details, { position: since, current: 1 }, `since ${since}: exactly position and current`);
			}
			s.setTime(T0 + 2 * 365 * 86_400_000);
			same(answered(await s.call("follow", { kind: "note", tags: ["topic:a"], since: 1 }), "since the position"), { position: 1, through: 1, changes: [] }, "no items, through at the position, however long after");
		}),
	},
	{
		name: "a since whose first following change is one millisecond inside the history bound is followed, and exactly at it refused position-not-held, before and after a restart and with the clock set back",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			const first = (await create(s, note("alpha", ["topic:a"]))).entity;
			s.setTime(T0 + 500);
			await create(s, note("beta", ["topic:a"]));
			s.setTime(T0 + 999);
			const inside = await followAll(s, { kind: "note", tags: ["topic:a"], since: 0 }, "one millisecond inside the bound");
			same(inside.items[0], item("entering", first.created, first.id, first), "followed");
			s.setTime(T0 + 1000);
			same(refused(await s.call("follow", { kind: "note", since: 0 }), "position-not-held", "exactly at the bound").details, { position: 0 }, "exactly position");
			await s.restart();
			same(refused(await s.call("follow", { kind: "note", since: 0 }), "position-not-held", "after a restart").details, { position: 0 }, "after a restart");
			s.setTime(T0 + 100);
			same(refused(await s.call("follow", { kind: "note", since: 0 }), "position-not-held", "the clock set back").details, { position: 0 }, "the clock set back");
			same((await followAll(s, { kind: "note", since: 1 }, "since 1")).items.length, 1, "since 1 still held");
		}),
	},
	{
		name: "a follow from a position gives the same items after a restart",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha", ["topic:a"]));
			const made = (await create(s, note("beta", ["topic:a"]))).entity;
			await update(s, { target: { id: made.id }, tags: [] });
			const before = await followAll(s, { kind: "note", tags: ["topic:a"], since: 1 }, "before the restart");
			await s.restart();
			const after = await followAll(s, { kind: "note", tags: ["topic:a"], since: 1 }, "after the restart");
			same(after, before, "the same items, through and position");
			same(after.items.map((x: Json) => x.event), ["entering", "leaving"], "beta entering, then leaving");
		}),
	},
	{
		name: "an envelope of 27 levels is given whole as an item's entity",
		run: (h) => withStore(h, {}, async (s) => {
			const made = (await create(s, { kind: "any", name: "deep", tags: [], body: nestArrays(26) })).entity;
			same((await followAll(s, { kind: "any", since: 0 }, "a deep envelope")).items, [item("entering", made.created, made.id, made)], "the envelope of 27 levels, whole");
		}),
	},
];
