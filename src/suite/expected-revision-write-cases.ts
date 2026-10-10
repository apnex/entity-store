/**
 * expected-revision-write: a write may name the revision it expects, and is refused if another change got
 * there first (zorg's target, EM6 and EM9's `revision-moved`).
 */
import { answered, create, note, positionOf, read, refused, same, withStore } from "./suite-check.js";
import type { SuiteCase } from "./suite-types.js";

export const expectedRevisionWriteCases: SuiteCase[] = [
	{
		name: "an update naming the current revision is applied",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			const updated = answered(await s.call("update", { target: { id: "e1.1" }, expectedRevision: 1, tags: ["a:b"] }), "update at revision 1");
			same(updated.entity.revision, 2, "the update applied");
			const again = answered(await s.call("update", { target: { kind: "note", name: "alpha" }, expectedRevision: 2, name: "beta" }), "update at revision 2");
			same([again.entity.revision, again.entity.name], [3, "beta"], "the second update applied");
		}),
	},
	{
		name: "an update naming another revision is refused naming both, takes no position and changes nothing",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] });
			const before = await read(s, { id: "e1.1" });
			const stale = refused(await s.call("update", { target: { id: "e1.1" }, expectedRevision: 1, tags: ["c:d"] }), "revision-moved", "a stale revision");
			same(stale.details, { expected: 1, current: 2 }, "the refusal names the expected and current revisions");
			const ahead = refused(await s.call("update", { target: { id: "e1.1" }, expectedRevision: 7, tags: ["c:d"] }), "revision-moved", "a revision not yet reached");
			same(ahead.details, { expected: 7, current: 2 }, "a revision ahead is refused the same way");
			same(await read(s, { id: "e1.1" }), before, "the entity and the store's position are unchanged");
		}),
	},
	{
		name: "a delete naming another revision is refused, and one naming the current revision is applied",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			await s.call("update", { target: { id: "e1.1" }, body: { summary: "two" } });
			const stale = refused(await s.call("delete", { target: { id: "e1.1" }, expectedRevision: 1 }), "revision-moved", "a stale delete");
			same(stale.details, { expected: 1, current: 2 }, "the refusal names both revisions");
			same(await positionOf(s), 2, "the refusal took no position");
			const deleted = answered(await s.call("delete", { target: { id: "e1.1" }, expectedRevision: 2 }), "a delete at the current revision");
			same(deleted.deleted.revision, 3, "the deletion is the entity's next revision");
		}),
	},
	{
		name: "of two writers who read the same revision, the second to write is refused because the first got there first",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"), { writer: "alice" });
			const seenByAlice = (await read(s, { id: "e1.1" })).entity.revision;
			const seenByBob = (await read(s, { id: "e1.1" })).entity.revision;
			answered(await s.call("update", { target: { id: "e1.1" }, expectedRevision: seenByAlice, body: { summary: "alice" } }, { writer: "alice" }), "alice writes first");
			const bob = refused(await s.call("update", { target: { id: "e1.1" }, expectedRevision: seenByBob, body: { summary: "bob" } }, { writer: "bob" }), "revision-moved", "bob writes second");
			same(bob.details, { expected: 1, current: 2 }, "bob is told the revision moved from 1 to 2");
			same((await read(s, { id: "e1.1" })).entity.body.summary, "alice", "alice's change stands");
		}),
	},
	{
		name: "a write naming no expected revision is applied whatever the current revision",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			for (let i = 0; i < 3; i++) await s.call("update", { target: { id: "e1.1" }, body: { summary: `v${i}` } });
			same((await read(s, { id: "e1.1" })).entity.revision, 4, "every update applied");
			same(answered(await s.call("delete", { target: { id: "e1.1" } }), "delete").deleted.revision, 5, "the delete applied");
		}),
	},
	{
		name: "an update or delete of an entity that does not exist is refused as not-found before its revision is compared",
		run: (h) => withStore(h, {}, async (s) => {
			const update = refused(await s.call("update", { target: { id: "e5.1" }, expectedRevision: 1, name: "x" }), "not-found", "an update of nothing");
			same(update.details, { target: { id: "e5.1" } }, "not-found names the target");
			refused(await s.call("delete", { target: { kind: "note", name: "gone" }, expectedRevision: 1 }), "not-found", "a delete of nothing");
		}),
	},
];
