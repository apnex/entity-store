/**
 * identity-name-lookup: read one entity by identity or by name, with the position the answer reflects
 * (zorg's target, EM1, EM9's target rules and EM10's `read`; D22).
 */
import { answered, create, note, read, refused, same, withStore } from "./suite-check.js";
import type { SuiteCase } from "./suite-types.js";

export const identityNameLookupCases: SuiteCase[] = [
	{
		name: "a read by identity and a read by kind and name return the same entity, with the store's position",
		run: (h) => withStore(h, {}, async (s) => {
			const made = await create(s, note("alpha"));
			await create(s, note("beta"));
			const byId = await read(s, { id: made.entity.id });
			const byName = await read(s, { kind: "note", name: "alpha" });
			same(byId, { position: 2, entity: made.entity }, "by identity, as of position 2");
			same(byName, byId, "by name, the same answer");
		}),
	},
	{
		name: "a read naming no entity answers null with the store's position",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			same(await read(s, { id: "e9.1" }), { position: 1, entity: null }, "an unknown identity");
			same(await read(s, { kind: "note", name: "nobody" }), { position: 1, entity: null }, "an unknown name");
			same(await read(s, { kind: "any", name: "alpha" }), { position: 1, entity: null }, "a name held only in another kind");
		}),
	},
	{
		name: "a name matches ^[a-z0-9][a-z0-9-]{0,62}$: 63 characters are accepted and 64, capitals, a leading hyphen or an empty name refused",
		run: (h) => withStore(h, {}, async (s) => {
			const longest = `a${"b".repeat(62)}`;
			same((await create(s, note(longest))).entity.name, longest, "a name of 63 characters");
			for (const bad of [`a${"b".repeat(63)}`, "Alpha", "-alpha", "", "al_pha", "al pha"]) {
				const refusal = refused(await s.call("create", note(bad)), "invalid-name", `the name ${JSON.stringify(bad)}`);
				same(refusal.details, { name: bad }, "the refusal names the name");
			}
			same((await create(s, note("0-9"))).entity.name, "0-9", "a name may start with a digit");
		}),
	},
	{
		name: "names are compared exactly and are unique within a kind, but not across kinds",
		run: (h) => withStore(h, {}, async (s) => {
			const alpha = await create(s, note("alpha"));
			const taken = refused(await s.call("create", note("alpha")), "name-taken", "the same name again in the kind");
			same(taken.details, { kind: "note", name: "alpha", id: alpha.entity.id }, "name-taken names the kind, the name and the holder");
			same((await create(s, note("alpha-"))).entity.name, "alpha-", "a name differing by one character is another name");
			same((await create(s, { kind: "any", name: "alpha", tags: [], body: 1 })).entity.kind, "any", "the same name in another kind");
		}),
	},
	{
		name: "a deleted entity's name is free again, and reading it by name finds the new entity",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			answered(await s.call("delete", { target: { kind: "note", name: "alpha" } }), "delete");
			const again = await create(s, note("alpha", [], "second"));
			same(again.entity.id, "e3.1", "the name is taken again by a new entity");
			same((await read(s, { kind: "note", name: "alpha" })).entity, again.entity, "the name reads as the new entity");
		}),
	},
	{
		name: "a rename moves the name: the old name reads null, the new one finds the entity, and a taken name is refused",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			const beta = await create(s, note("beta"));
			const renamed = answered(await s.call("update", { target: { kind: "note", name: "alpha" }, name: "gamma" }), "rename");
			same((await read(s, { kind: "note", name: "alpha" })).entity, null, "the old name is free");
			same((await read(s, { kind: "note", name: "gamma" })).entity, renamed.entity, "the new name finds the entity");
			const taken = refused(await s.call("update", { target: { id: "e1.1" }, name: "beta" }), "name-taken", "a rename to a taken name");
			same(taken.details, { kind: "note", name: "beta", id: beta.entity.id }, "it names the name taken and its holder");
			same((await create(s, note("alpha"))).entity.id, "e4.1", "the old name may be taken by another entity");
			same(answered(await s.call("update", { target: { id: "e1.1" }, name: "gamma" }), "keep own name").entity.revision, 3, "an update that keeps its own name succeeds");
		}),
	},
	{
		name: "a target is exactly an identity or exactly a kind and a name; anything else is refused as invalid-target",
		run: (h) => withStore(h, {}, async (s) => {
			await create(s, note("alpha"));
			for (const target of [{}, { kind: "note" }, { name: "alpha" }, { id: "e1.1", kind: "note" }, { id: "e1.1", name: "alpha" }, { id: "e1.1", kind: "note", name: "alpha" }]) {
				const refusal = refused(await s.call("read", { target }), "invalid-target", `read ${JSON.stringify(target)}`);
				same(refusal.details, {}, "invalid-target names no details");
				refused(await s.call("update", { target, tags: [] }), "invalid-target", `update ${JSON.stringify(target)}`);
				refused(await s.call("delete", { target }), "invalid-target", `delete ${JSON.stringify(target)}`);
			}
		}),
	},
	{
		name: "a read naming a kind the store was not given is refused as unknown-kind",
		run: (h) => withStore(h, {}, async (s) => {
			const refusal = refused(await s.call("read", { target: { kind: "nope", name: "alpha" } }), "unknown-kind", "an unknown kind");
			same(refusal.details, { kind: "nope" }, "the refusal names the kind");
		}),
	},
];
