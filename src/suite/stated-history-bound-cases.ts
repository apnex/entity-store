/**
 * stated-history-bound: history is kept to a bound the application states, any reader can read the bound,
 * and a reader behind it is told so (zorg's target, EM8, EM10's `history-bound` and `position-not-held`).
 */
import { answered, create, note, refused, same, T0, withStore, type Json } from "./suite-check.js";
import type { SuiteCase, SuiteSession } from "./suite-types.js";

const find = (s: SuiteSession, input: Json) => s.call("find", input);

export const statedHistoryBoundCases: SuiteCase[] = [
	{
		name: "any reader reads the bound the store was opened with, with the store's position, and a restart keeps it",
		run: (h) => withStore(h, { historyMs: 86_400_000 }, async (s) => {
			same(answered(await s.call("history-bound", {}), "history-bound"), { position: 0, historyMs: 86_400_000 }, "the bound of an empty store");
			await create(s, note("alpha"));
			same(answered(await s.call("history-bound", {}, { writer: "bob" }), "history-bound"), { position: 1, historyMs: 86_400_000 }, "any reader reads it, with the position");
			await s.restart();
			same(answered(await s.call("history-bound", {}), "history-bound"), { position: 1, historyMs: 86_400_000 }, "the same bound after a restart");
		}),
	},
	{
		name: "a find as of an earlier position is answered while the change after it is within the bound: one millisecond inside, and refused exactly at the bound",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			await create(s, note("alpha"));
			s.setTime(T0 + 500);
			await create(s, note("beta"));
			s.setTime(T0 + 999);
			same(answered(await find(s, { kind: "note", asOf: 0 }), "as of 0, 1 ms inside").entries, [], "as of 0 is held one millisecond inside the bound");
			s.setTime(T0 + 1000);
			const refusal = refused(await find(s, { kind: "note", asOf: 0 }), "position-not-held", "as of 0, at the bound");
			same(refusal.details, { position: 0 }, "the refusal names the position");
			same(answered(await find(s, { kind: "note", asOf: 1 }), "as of 1").position, 1, "as of 1 is held: the change after it, at 500, is within the bound");
			s.setTime(T0 + 1500);
			refused(await find(s, { kind: "note", asOf: 1 }), "position-not-held", "as of 1, at its bound");
		}),
	},
	{
		name: "the store's own position is always held, however long since its latest change",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			s.setTime(T0 + 86_400_000);
			same(answered(await find(s, { kind: "note", asOf: 0 }), "empty store"), { position: 0, entries: [], next: null }, "an empty store's position 0 is its own, and held");
			await create(s, note("alpha"));
			s.setTime(T0 + 2 * 365 * 86_400_000);
			same(answered(await find(s, { kind: "note", asOf: 1 }), "as of the current position").position, 1, "as of the store's position");
			same(answered(await find(s, { kind: "note" }), "naming no position").position, 1, "naming no position");
		}),
	},
	{
		name: "once a find has found a position outside the bound it stays outside when the clock is set back",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			await create(s, note("alpha"));
			s.setTime(T0 + 1000);
			refused(await find(s, { kind: "note", asOf: 0 }), "position-not-held", "at the bound");
			s.setTime(T0 + 10);
			refused(await find(s, { kind: "note", asOf: 0 }), "position-not-held", "with the clock set back");
			await s.restart();
			refused(await find(s, { kind: "note", asOf: 0 }), "position-not-held", "with the clock set back, after a restart");
		}),
	},
	{
		name: "the schedule: changes at 1000 and 1900 with a bound of 1000, a find as of 0 at 2000 refused before and after a restart with the clock at 1900, and as of 1 answered",
		run: (h) => withStore(h, { historyMs: 1000 }, async (s) => {
			const first = await create(s, note("alpha"));
			s.setTime(1900);
			await create(s, note("beta"));
			s.setTime(2000);
			same(refused(await find(s, { kind: "note", asOf: 0 }), "position-not-held", "as of 0 at 2000").details, { position: 0 }, "refused before the restart");
			await s.restart();
			s.setTime(1900);
			refused(await find(s, { kind: "note", asOf: 0 }), "position-not-held", "as of 0 after the restart, the store's time being 2000");
			const asOf1 = answered(await find(s, { kind: "note", asOf: 1 }), "as of 1 after the restart");
			same([asOf1.position, asOf1.entries], [1, [first.entity]], "as of 1 is answered with the state as of 1");
		}, 1000),
	},
];
