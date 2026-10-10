/**
 * repeat-recognition: a write carries an identity its writer supplies; a repeat under it takes no second
 * position and returns the first answer, while the change it repeats is within the history bound (zorg's
 * target, EM7 and EM8; E4).
 */
import { answered, create, note, positionOf, read, refused, same, T0, withStore } from "./suite-check.js";
import type { SuiteCase } from "./suite-types.js";

export const repeatRecognitionCases: SuiteCase[] = [
	{
		name: "a create, an update and a delete each repeated under its write identity return the first answer and take no position",
		run: (h) => withStore(h, {}, async (s) => {
			const [c, u, d] = [s.newWriteId(), s.newWriteId(), s.newWriteId()];
			const created = await create(s, note("alpha"), { writeId: c });
			const updated = answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: u }), "update");
			const deleted = answered(await s.call("delete", { target: { id: "e1.1" } }, { writeId: d }), "delete");
			same(answered(await s.call("create", note("alpha"), { writeId: c }), "repeat create"), created, "the create's repeat returns its first answer");
			same(answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: u }), "repeat update"), updated, "the update's repeat returns its first answer, though the entity is deleted since");
			same(answered(await s.call("delete", { target: { id: "e1.1" } }, { writeId: d }), "repeat delete"), deleted, "the delete's repeat returns its first answer, not not-found");
			same(await positionOf(s), 3, "the repeats took no position");
			same(answered(await s.call("find", { kind: "note" }), "find").entries, [], "the store changed once for each write");
		}),
	},
	{
		name: "the same input with its properties in another order is the same write",
		run: (h) => withStore(h, {}, async (s) => {
			const writeId = s.newWriteId();
			const first = await create(s, { kind: "note", name: "alpha", tags: [], body: { pointer: "https://e.x/", summary: "s" } }, { writeId });
			const again = answered(await s.call("create", { body: { summary: "s", pointer: "https://e.x/" }, tags: [], name: "alpha", kind: "note" }, { writeId }), "reordered repeat");
			same(again, first, "the digest is over canonical JSON, so the repeat is recognised");
		}),
	},
	{
		name: "a retained write identity repeated with another input, another operation or another writer is refused as identity-reused",
		run: (h) => withStore(h, {}, async (s) => {
			const writeId = s.newWriteId();
			await create(s, note("alpha"), { writeId, writer: "alice" });
			const input = refused(await s.call("create", note("beta"), { writeId, writer: "alice" }), "identity-reused", "another input");
			same(input.details, { writeId }, "the refusal names the write identity");
			refused(await s.call("delete", { target: { id: "e1.1" } }, { writeId, writer: "alice" }), "identity-reused", "another operation");
			refused(await s.call("create", note("alpha"), { writeId, writer: "bob" }), "identity-reused", "another writer: the writer is part of the digest");
			same(await positionOf(s), 1, "no refusal took a position");
			same((await read(s, { kind: "note", name: "beta" })).entity, null, "the other input was not applied");
		}),
	},
	{
		name: "a refused write is not remembered: its repeat runs afresh, and its identity may carry another write",
		run: (h) => withStore(h, {}, async (s) => {
			const writeId = s.newWriteId();
			const first = refused(await s.call("create", note("Bad Name"), { writeId }), "invalid-name", "a refused create");
			same(refused(await s.call("create", note("Bad Name"), { writeId }), "invalid-name", "its repeat"), first, "the repeat runs afresh and is refused the same way");
			const accepted = await create(s, note("good-name"), { writeId });
			same(accepted.position, 1, "another write under the identity is accepted, not refused as reused");
			same(answered(await s.call("create", note("good-name"), { writeId }), "repeat of the accepted write"), accepted, "the identity now names the accepted change");
		}),
	},
	{
		name: "a recognised repeat returns the first answer unchanged, though the entity changed since",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			const writeId = s.newWriteId();
			const first = answered(await s.call("update", { target: { id: "e1.1" }, body: { summary: "one" } }, { writeId }), "update");
			await s.call("update", { target: { id: "e1.1" }, body: { summary: "two" } });
			same(answered(await s.call("update", { target: { id: "e1.1" }, body: { summary: "one" } }, { writeId }), "repeat"), first, "the first answer, with its position and entity as they were");
			same((await read(s, { id: "e1.1" })).entity.body.summary, "two", "the repeat changed nothing");
		}),
	},
	{
		name: "a repeat one millisecond inside the bound is recognised, and one exactly at the bound runs afresh",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			await create(s, note("alpha"));
			const writeId = s.newWriteId();
			const input = { target: { id: "e1.1" }, body: { summary: "repeat me" } };
			const first = answered(await s.call("update", input, { writeId }), "update at T0");
			s.setTime(T0 + 999);
			same(answered(await s.call("update", input, { writeId }), "repeat 1 ms inside"), first, "recognised one millisecond inside the bound");
			s.setTime(T0 + 1000);
			const fresh = answered(await s.call("update", input, { writeId }), "repeat at the bound");
			same([fresh.position, fresh.entity.revision], [3, 3], "at the bound the update runs afresh and takes a new position");
			s.setTime(T0 + 1001);
			same(answered(await s.call("update", input, { writeId }), "repeat after the fresh run"), fresh, "the identity now names the fresh change");
		}),
	},
	{
		name: "repeats of a create, an update and a delete are recognised inside the bound and run afresh outside it, the same before and after a restart",
		run: (h) => withStore(h, { historyMs: 10_000 }, async (s) => {
			const [c, u, d] = [s.newWriteId(), s.newWriteId(), s.newWriteId()];
			const created = await create(s, note("alpha"), { writeId: c });
			await create(s, note("beta"));
			const updated = answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: u }), "update");
			const deleted = answered(await s.call("delete", { target: { id: "e2.1" } }, { writeId: d }), "delete");
			for (const when of ["before", "after"]) {
				if (when === "after") await s.restart();
				s.setTime(T0 + 9_999);
				same(answered(await s.call("create", note("alpha"), { writeId: c }), "create"), created, `create recognised inside the bound, ${when} a restart`);
				same(answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: u }), "update"), updated, `update recognised, ${when} a restart`);
				same(answered(await s.call("delete", { target: { id: "e2.1" } }, { writeId: d }), "delete"), deleted, `delete recognised, ${when} a restart`);
				same(await positionOf(s), 4, `no repeat took a position, ${when} a restart`);
			}
			await s.restart();
			s.setTime(T0 + 10_000);
			refused(await s.call("create", note("alpha"), { writeId: c }), "name-taken", "at the bound the create runs afresh and meets its own entity's name");
			const fresh = answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: u }), "update afresh");
			same(fresh.position, 5, "at the bound the update runs afresh and takes the next position");
			refused(await s.call("delete", { target: { id: "e2.1" } }, { writeId: d }), "not-found", "at the bound the delete runs afresh and finds nothing to delete");
			await s.restart();
			same(answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: u }), "repeat of the fresh update"), fresh, "after a restart the identity names the fresh change");
		}),
	},
	{
		name: "the schedule: changes at 1000 and 1900 with a bound of 1000, a repeat of the second at 2000, a restart with the clock at 1900, and a repeat of the first runs afresh",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			const [first, second] = [s.newWriteId(), s.newWriteId()];
			await create(s, note("alpha"), { writeId: first });
			s.setTime(1900);
			const updated = answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: second }), "the change at 1900");
			s.setTime(2000);
			same(answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: second }), "repeat at 2000"), updated, "the repeat of the second at 2000 is recognised");
			await s.restart();
			s.setTime(1900);
			refused(await s.call("create", note("alpha"), { writeId: first }), "name-taken", "the repeat of the first runs afresh: the store's time is 2000, not the clock's 1900");
			same(answered(await s.call("update", { target: { id: "e1.1" }, tags: ["a:b"] }, { writeId: second }), "the second again"), updated, "the second is still recognised at 2000");
			same(await positionOf(s), 2, "nothing took a position");
		}, 1000),
	},
];
