/**
 * positioned-entity-write: create, update and delete entities; each change - one or more writes, applied
 * all or nothing - takes exactly one position (zorg's target, EM3, EM6 and EM10's update rules; E3).
 */
import { answered, check, create, note, positionOf, read, refused, same, withStore, type Json } from "./suite-check.js";
import type { SuiteCase } from "./suite-types.js";

export const positionedEntityWriteCases: SuiteCase[] = [
	{
		name: "an empty store is at position 0, and the first change takes position 1 and the next the next integer",
		run: (h) => withStore(h, {}, async (s) => {
			same(await positionOf(s), 0, "the empty store's position");
			same((await read(s, { id: "e1.1" })).position, 0, "a read of the empty store answers as of 0");
			const first = await create(s, note("alpha"));
			same(first.position, 1, "the first change's position");
			const second = await create(s, note("beta"));
			same(second.position, 2, "the second change's position");
			same(await positionOf(s), 2, "the store's position is its latest change's");
		}),
	},
	{
		name: "a create gives the identity e<position>.1, revision 1, and the envelope whole",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			const answer = await create(s, note("beta", ["topic:b"]));
			same(Object.keys(answer).sort(), ["entity", "position"], "a create answers position and entity");
			same(answer.entity.id, "e2.1", "the identity is e, the position, a dot and the write's place");
			same(answer.entity.revision, 1, "a new entity's revision");
			same(answer.entity.kind, "note", "the kind");
			same(answer.entity.name, "beta", "the name");
			same(answer.entity.tags, ["topic:b"], "the tags");
		}),
	},
	{
		name: "an update and a delete each take the next position and one more revision, the deletion included",
		run: (h) => withStore(h, {}, async (s) => {
			const created = await create(s, note("alpha"));
			const updated = answered(await s.call("update", { target: { id: created.entity.id }, tags: ["a:b"] }), "update");
			same([updated.position, updated.entity.revision], [2, 2], "the update's position and revision");
			const again = answered(await s.call("update", { target: { kind: "note", name: "alpha" }, body: { summary: "again" } }), "update by name");
			same([again.position, again.entity.revision], [3, 3], "the second update's position and revision");
			const deleted = answered(await s.call("delete", { target: { id: created.entity.id } }), "delete");
			same(deleted, { position: 4, deleted: { id: "e1.1", kind: "note", name: "alpha", revision: 4 } }, "a delete answers the identity, kind, name and final revision");
			same(await read(s, { id: "e1.1" }), { position: 4, entity: null }, "a deleted entity reads as absent");
		}),
	},
	{
		name: "an update that names only the entity's own name is a change: it takes a position and a revision",
		run: (h) => withStore(h, {}, async (s) => {
			const created = await create(s, note("alpha"));
			const updated = answered(await s.call("update", { target: { id: "e1.1" }, name: "alpha" }), "update naming its own name");
			same(updated.position, 2, "it takes the next position");
			same(updated.entity.revision, 2, "it takes the next revision");
			same({ ...updated.entity, revision: 1, changed: created.entity.changed }, created.entity, "nothing else changes but revision and changed");
			same(updated.entity.changed.position, 2, "changed records the new change");
		}),
	},
	{
		name: "an update naming the current tags or body is a change too",
		run: (h) => withStore(h, {}, async (s) => {
			const created = await create(s, note("alpha", ["a:b"]));
			const tags = answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }), "same tags");
			const body = answered(await s.call("update", { target: { id: "e1.1" }, body: created.entity.body }), "same body");
			same([tags.position, tags.entity.revision, body.position, body.entity.revision], [2, 2, 3, 3], "each takes a position and a revision");
		}),
	},
	{
		name: "a refused write takes no position, and the next change takes the next one",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			refused(await s.call("create", note("alpha")), "name-taken", "a create of a taken name");
			refused(await s.call("update", { target: { id: "e9.1" }, name: "x" }), "not-found", "an update of nothing");
			refused(await s.call("create", { kind: "nope", name: "a", tags: [], body: 1 }), "unknown-kind", "a create of an unknown kind");
			same(await positionOf(s), 1, "the store's position is unchanged by refusals");
			same((await create(s, note("beta"))).position, 2, "the next change takes the next position");
		}),
	},
	{
		name: "a recognised repeat takes no position, and the next change takes the next one",
		run: (h) => withStore(h, {}, async (s) => {
			const writeId = s.newWriteId();
			const first = await create(s, note("alpha"), { writeId });
			same(await create(s, note("alpha"), { writeId }), first, "the repeat returns the first answer");
			same(await positionOf(s), 1, "the repeat took no position");
			same((await create(s, note("beta"))).position, 2, "the next change takes the next position");
		}),
	},
	{
		name: "an identity never changes, including on a rename, and is never reused after a delete",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			const renamed = answered(await s.call("update", { target: { id: "e1.1" }, name: "omega" }), "rename");
			same(renamed.entity.id, "e1.1", "a rename keeps the identity");
			answered(await s.call("delete", { target: { id: "e1.1" } }), "delete");
			const again = await create(s, note("omega"));
			same(again.entity.id, "e4.1", "a new entity of the freed name has a new identity");
			same((await read(s, { id: "e1.1" })).entity, null, "the old identity still names the deleted entity");
		}),
	},
	{
		name: "positions rise strictly and never repeat under writes interleaved from two writers, and every read and find answers as of the position it reports",
		run: (h) => withStore(h, {}, async (s) => {
			const seen: number[] = [];
			const states: Json[] = [];
			for (let i = 0; i < 6; i++) {
				const writer = i % 2 === 0 ? "alice" : "bob";
				const made = await create(s, note(`n${i}`, [`by:${writer}`]), { writer });
				seen.push(made.position);
				if (i % 3 === 2) seen.push(answered(await s.call("update", { target: { id: made.entity.id }, tags: ["x:y"] }, { writer: "bob" }), "update").position);
				const found = answered(await s.call("find", { kind: "note" }), "find");
				same(found.position, seen.at(-1), "a find answers as of the store's latest position");
				states.push(found);
				const r = await read(s, { id: made.entity.id });
				same(r.position, seen.at(-1), "a read answers as of the store's latest position");
				check(r.entity.changed.position <= r.position, "a read never shows a change after its position");
			}
			for (let i = 1; i < seen.length; i++) same((seen[i] as number) - (seen[i - 1] as number), 1, "each change takes the next position");
			for (const state of states) {
				same(answered(await s.call("find", { kind: "note", asOf: state.position }), `find as of ${state.position}`), state, "a find as of an earlier position answers the state as of it");
			}
		}),
	},
	{
		name: "an update's body replaces the top-level properties it names when both are objects, and the whole body otherwise",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, { kind: "any", name: "obj", tags: [], body: { a: 1, b: { c: 2 } } });
			const merged = answered(await s.call("update", { target: { id: "e1.1" }, body: { b: { d: 3 }, e: 4 } }), "merge");
			same(merged.entity.body, { a: 1, b: { d: 3 }, e: 4 }, "top-level properties named are replaced, others kept");
			const replaced = answered(await s.call("update", { target: { id: "e1.1" }, body: [1, 2] }), "replace with an array");
			same(replaced.entity.body, [1, 2], "a body that is not an object replaces the whole body");
			const back = answered(await s.call("update", { target: { id: "e1.1" }, body: { z: null } }), "replace an array with an object");
			same(back.entity.body, { z: null }, "an object over a non-object replaces the whole body");
			const tags = answered(await s.call("update", { target: { id: "e1.1" }, tags: ["b:b", "a:a"] }), "tags replace");
			same(tags.entity.tags, ["a:a", "b:b"], "an update's tags replace the whole set");
		}),
	},
];
