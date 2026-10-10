// local-store - small fixtures for the contract tests that use a store directly rather than through the
// shared suite: the suite's kinds, its start time, and a store over memory storage with a settable clock.
import { SHAPE_DIALECT_ID } from "@apnex/shape-check";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";

/** 2026-10-09T10:00:00.000Z, the time the suite's cases start at. */
export const T0 = Date.UTC(2026, 9, 9, 10, 0, 0, 0);

/** The body shape of zorg's knowledge entry (EM4), as one ordinary kind. */
export const NOTE_SHAPE = {
	$schema: SHAPE_DIALECT_ID,
	type: "object",
	properties: {
		pointer: { type: "string", format: "uri", maxLength: 2048 },
		summary: { type: "string", minLength: 1, maxLength: 1024 },
	},
	required: ["pointer", "summary"],
	additionalProperties: false,
};

export const KINDS = { note: NOTE_SHAPE, any: { $schema: SHAPE_DIALECT_ID } };

/** A note's create input. */
export const note = (name, tags = []) => ({ kind: "note", name, tags, body: { pointer: `https://example.com/${name}`, summary: `about ${name}` } });

/** Opens a store that must open, over a memory port unless one is given, with a clock the caller sets through `clock.set`. */
export function openLocal({ storage = createMemoryStoragePort(), time = T0, historyMs = 60_000, maxEntityBytes = 65_536, kinds = KINDS, clock } = {}) {
	let now = time;
	const port = clock ?? { now: () => now, set: (ms) => { now = ms; } };
	const opening = openEntityStore({ storage, clock: port, historyMs, maxEntityBytes, kinds });
	if (!opening.opened) throw new Error(`the store did not open: ${JSON.stringify(opening.refusal)}`);
	return { store: opening.store, storage, clock: port };
}
