/**
 * What the shared contract suite runs against: a harness that opens a store and gives the suite one
 * session over it, whether the store is in the same process or reached remotely through entity-api.
 *
 * The suite controls the store's clock through the session, names the writer of every write as the host
 * would, and asks the harness for write identities, so a remote harness can make them invocation
 * identities (zorg's target, EM7, EM11). Nothing here is particular to one runtime (D31).
 */
import type { JsonInput } from "@apnex/shape-check";

/** The operations a session calls, by the names entity-api serves them under (EM10). */
export type SuiteOperation = "create" | "update" | "delete" | "read" | "find" | "history-bound";

/** How a call ended: answered with the operation's answer, or refused with the refusal record (EM9). */
export type SuiteOutcome =
	| { readonly outcome: "answered"; readonly answer: unknown }
	| { readonly outcome: "refused"; readonly refusal: unknown };

/** The store a case asks for: its kinds, its history bound and its largest entity size (EM8, EM10). */
export interface SuiteStoreOptions {
	readonly kinds: { readonly [kind: string]: JsonInput };
	readonly historyMs: number;
	readonly maxEntityBytes: number;
}

/** Who makes a call: the writer the host names, and the write identity of a write. */
export interface SuiteCaller {
	/** The writer the host names for the call; the harness's default when absent. */
	readonly writer?: string;
	/** The write identity of a write; a new one from the harness when absent. Ignored for reads. */
	readonly writeId?: string;
}

/** One open store, as one case sees it. */
export interface SuiteSession {
	/** Sets the time, in milliseconds since 1970, that the store's clock port gives from now on. */
	setTime(ms: number): void;
	/** A write identity never given before. */
	newWriteId(): string;
	/** Calls one operation with an input, as the caller names. */
	call(operation: SuiteOperation, input: unknown, caller?: SuiteCaller): Promise<SuiteOutcome>;
	/**
	 * Stops the store abruptly, as a killed process stops, and opens it again on the same storage with the
	 * same options; the clock keeps the time last set.
	 */
	restart(): Promise<void>;
	/** Ends the session; nothing more is called on it. */
	close(): Promise<void>;
}

/** What a consumer of the suite supplies: a way to open a store, its clock first set to `time`. */
export interface SuiteHarness {
	open(options: SuiteStoreOptions, time: number): Promise<SuiteSession>;
}

/** One case of the suite. */
export interface SuiteCase {
	readonly name: string;
	run(harness: SuiteHarness): Promise<void>;
}

/** How the suite registers a case with the consumer's test runner, as node:test's `test` does. */
export type SuiteRegister = (name: string, run: () => Promise<void>) => unknown;
