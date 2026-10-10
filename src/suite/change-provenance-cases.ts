/**
 * change-provenance: each change records when it was made and the writer the application names,
 * unchecked (zorg's target, EM5, EM6's time and EM8's store time; D13).
 */
import { answered, create, iso, note, read, same, T0, withStore } from "./suite-check.js";
import type { SuiteCase } from "./suite-types.js";

export const changeProvenanceCases: SuiteCase[] = [
	{
		name: "every read returns the envelope whole, created and changed each carrying position, time and writer",
		run: (h) => withStore(h, {}, async (s) => {
			const made = await create(s, note("alpha", ["topic:b", "project:a"]), { writer: "alice" });
			const expected = {
				id: "e1.1",
				kind: "note",
				name: "alpha",
				tags: ["project:a", "topic:b"],
				body: { pointer: "https://example.com/alpha", summary: "about alpha" },
				revision: 1,
				created: { position: 1, at: iso(T0), writer: "alice" },
				changed: { position: 1, at: iso(T0), writer: "alice" },
			};
			same(made.entity, expected, "the create's answer is the whole envelope");
			same((await read(s, { id: "e1.1" })).entity, expected, "a read by identity returns it whole");
			same((await read(s, { kind: "note", name: "alpha" })).entity, expected, "a read by name returns it whole");
			same(answered(await s.call("find", { kind: "note" }), "find").entries, [expected], "a find returns it whole");
		}),
	},
	{
		name: "an update keeps created and records its own position, time and writer in changed",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"), { writer: "alice" });
			s.setTime(T0 + 300_000);
			const updated = answered(await s.call("update", { target: { id: "e1.1" }, body: { summary: "new" } }, { writer: "bob" }), "update");
			same(updated.entity.created, { position: 1, at: iso(T0), writer: "alice" }, "created is the creating change's");
			same(updated.entity.changed, { position: 2, at: iso(T0 + 300_000), writer: "bob" }, "changed is the latest change's");
		}),
	},
	{
		name: "each change records the writer named for it, whoever made the entity before",
		run: (h) => withStore(h, {}, async (s) => {
			// Writers here are ones any host can name; local tests add writers no host would name.
			for (const [i, writer] of ["alice", "bob", "carol-2"].entries()) {
				const made = await create(s, note(`w${i}`), { writer });
				same([made.entity.created.writer, made.entity.changed.writer], [writer, writer], `the writer ${writer} is kept as named`);
			}
			const updated = answered(await s.call("update", { target: { id: "e1.1" }, tags: ["by:bob"] }, { writer: "bob" }), "an update by another writer");
			same([updated.entity.created.writer, updated.entity.changed.writer], ["alice", "bob"], "the store records the writer and checks nothing about it");
		}),
	},
	{
		name: "a change's time is the store's time in UTC to the millisecond, and it never goes back when the clock does",
		run: (h) => withStore(h, {}, async (s) => {
			s.setTime(T0 + 1234);
			const first = await create(s, note("alpha"));
			same(first.entity.created.at, "2026-10-09T10:00:01.234Z", "ISO 8601 in UTC to the millisecond");
			s.setTime(T0 - 60_000);
			const second = await create(s, note("beta"));
			same(second.entity.created.at, first.entity.created.at, "with the clock set back the store's time is the latest time it holds");
			s.setTime(T0 + 5000);
			same((await create(s, note("gamma"))).entity.created.at, iso(T0 + 5000), "with the clock ahead again the store's time follows it");
		}),
	},
	{
		name: "a deleted entity reads as absent by identity and by name, and its name is free",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			answered(await s.call("delete", { target: { kind: "note", name: "alpha" } }, { writer: "carol" }), "delete");
			same(await read(s, { id: "e1.1" }), { position: 2, entity: null }, "absent by identity");
			same(await read(s, { kind: "note", name: "alpha" }), { position: 2, entity: null }, "absent by name");
			same(answered(await s.call("find", { kind: "note" }), "find").entries, [], "absent from a find");
		}),
	},
];
