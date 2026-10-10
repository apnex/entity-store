/**
 * The suite's own checks and fixtures. Records are compared in canonical JSON written here, not taken
 * from the code under test, and a failed check throws an Error naming what differed, so the suite needs
 * no assertion module particular to one runtime (D31).
 */
import { SHAPE_DIALECT_ID } from "@apnex/shape-check";
import type { SuiteCaller, SuiteHarness, SuiteOutcome, SuiteSession, SuiteStoreOptions } from "./suite-types.js";

/** An answer or refusal as the suite reads it: plain JSON, whose form each check states. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

const byCodePoint = (a: string, b: string): number => {
	const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
	const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
	return x.length - y.length;
};

/** Canonical JSON (shape-check's SD4), written independently of the store's own. */
export function canonical(value: unknown): string {
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as { [name: string]: unknown };
		return `{${Object.keys(record).sort(byCodePoint).map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** The size in UTF-8 bytes of a value's canonical JSON. */
export function canonicalBytes(value: unknown): number {
	let n = 0;
	for (const c of canonical(value)) {
		const p = c.codePointAt(0) ?? 0;
		n += p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4;
	}
	return n;
}

/** Throws when a condition does not hold. */
export function check(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
}

/** Throws unless two values are equal as JSON, comparing their canonical JSON. */
export function same(actual: unknown, expected: unknown, message: string): void {
	const a = canonical(actual);
	const e = canonical(expected);
	if (a !== e) throw new Error(`${message}\n  expected: ${e.length > 600 ? `${e.slice(0, 600)}...` : e}\n  actual:   ${a.length > 600 ? `${a.slice(0, 600)}...` : a}`);
}

/** The answer of a call that must be answered. */
export function answered(outcome: SuiteOutcome, message: string): Json {
	if (outcome.outcome !== "answered") throw new Error(`${message}: expected an answer, got ${canonical(outcome).slice(0, 600)}`);
	return outcome.answer;
}

/** The refusal of a call that must be refused with a code; its record holds exactly EM9's fields. */
export function refused(outcome: SuiteOutcome, code: string, message: string): Json {
	if (outcome.outcome !== "refused") throw new Error(`${message}: expected refusal ${code}, got ${canonical(outcome).slice(0, 600)}`);
	const refusal = outcome.refusal as Json;
	same(refusal?.code, code, `${message}: the refusal's code`);
	const fields = code === "misfit" ? ["code", "details", "fix", "misfits", "part", "what", "why"] : ["code", "details", "fix", "part", "what", "why"];
	same(Object.keys(refusal).sort(), fields, `${message}: the refusal holds exactly EM9's fields`);
	same(refusal.part, "entity-store", `${message}: the refusal names entity-store`);
	for (const f of ["what", "why", "fix"]) check(typeof refusal[f] === "string" && refusal[f].length > 0, `${message}: the refusal's ${f} is a sentence`);
	check(refusal.details !== null && typeof refusal.details === "object" && !Array.isArray(refusal.details), `${message}: details is an object`);
	return refusal;
}

/** The body shape of zorg's knowledge entry (EM4), used here as one ordinary kind among several. */
export const NOTE_SHAPE = {
	$schema: SHAPE_DIALECT_ID,
	type: "object",
	properties: {
		pointer: { type: "string", format: "uri", maxLength: 2048 },
		summary: { type: "string", minLength: 1, maxLength: 1024 },
	},
	required: ["pointer", "summary"],
	additionalProperties: false,
} as const;

/** The kinds every case's store is given unless it asks otherwise: no kind is built in. */
export const KINDS = {
	note: NOTE_SHAPE,
	any: { $schema: SHAPE_DIALECT_ID },
	text: { $schema: SHAPE_DIALECT_ID, type: "string" },
	list: { $schema: SHAPE_DIALECT_ID, type: "array", items: { type: "string" } },
} as const;

/** The time each case starts at: 2026-10-09T10:00:00.000Z. */
export const T0 = Date.UTC(2026, 9, 9, 10, 0, 0, 0);

/** The options of a case's store, defaults overridden by what the case names. */
export function storeOptions(overrides: Partial<SuiteStoreOptions> = {}): SuiteStoreOptions {
	return { kinds: KINDS, historyMs: 60_000, maxEntityBytes: 65_536, ...overrides };
}

/** Opens a store, runs a case's body against it, and always closes the session. */
export async function withStore(harness: SuiteHarness, options: Partial<SuiteStoreOptions>, body: (s: SuiteSession) => Promise<void>, time = T0): Promise<void> {
	const session = await harness.open(storeOptions(options), time);
	try {
		await body(session);
	} finally {
		await session.close();
	}
}

/** A note's create input. */
export function note(name: string, tags: string[] = [], summary = `about ${name}`): Json {
	return { kind: "note", name, tags, body: { pointer: `https://example.com/${name}`, summary } };
}

/** Creates an entity that must be accepted, and returns the answer. */
export async function create(s: SuiteSession, input: Json, caller?: SuiteCaller): Promise<Json> {
	return answered(await s.call("create", input, caller), `create ${canonical(input).slice(0, 80)}`);
}

/** The store's position, read through history-bound. */
export async function positionOf(s: SuiteSession): Promise<number> {
	return answered(await s.call("history-bound", {}), "history-bound").position;
}

/** Reads an entity by a target, which must be answered. */
export async function read(s: SuiteSession, target: Json): Promise<Json> {
	return answered(await s.call("read", { target }), `read ${canonical(target)}`);
}

/** Milliseconds as the store writes a time: ISO 8601 in UTC to the millisecond. */
export function iso(ms: number): string {
	return new Date(ms).toISOString();
}
