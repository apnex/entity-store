/**
 * entity-store's shared contract suite (zorg's Delta 1, E11): a function taking a harness over a store
 * and the consumer's test registration, which registers every case for the rows entity-api carries, so
 * entity-api runs the same cases remotely and entity-store's own contract tests run them locally.
 *
 * The storage-port row runs locally only, in entity-store's own tests. The cases of follow-narrowed-set judge the
 * items and `through` across pages and keep within the input shape entity-api serves `follow` under, so they run
 * remotely too (zorg's target, EM17). Nothing here is particular to one runtime (D31).
 */
import { changeProvenanceCases } from "./suite/change-provenance-cases.js";
import { changesSincePositionCases } from "./suite/changes-since-position-cases.js";
import { entityLimitCases } from "./suite/entity-limit-cases.js";
import { expectedRevisionWriteCases } from "./suite/expected-revision-write-cases.js";
import { findByKindTagsCases } from "./suite/find-by-kind-tags-cases.js";
import { followNarrowedSetCases } from "./suite/follow-narrowed-set-cases.js";
import { identityNameLookupCases } from "./suite/identity-name-lookup-cases.js";
import { positionedEntityWriteCases } from "./suite/positioned-entity-write-cases.js";
import { repeatRecognitionCases } from "./suite/repeat-recognition-cases.js";
import { statedHistoryBoundCases } from "./suite/stated-history-bound-cases.js";
import { storeRefusalCases } from "./suite/store-refusal-cases.js";
import type { SuiteCase, SuiteHarness, SuiteRegister } from "./suite/suite-types.js";

export type { SuiteCaller, SuiteHarness, SuiteOperation, SuiteOutcome, SuiteRegister, SuiteSession, SuiteStoreOptions } from "./suite/suite-types.js";

/** The rows entity-api carries, each with its cases. */
const CASES: { readonly [row: string]: readonly SuiteCase[] } = {
	"positioned-entity-write": positionedEntityWriteCases,
	"change-provenance": changeProvenanceCases,
	"expected-revision-write": expectedRevisionWriteCases,
	"repeat-recognition": repeatRecognitionCases,
	"identity-name-lookup": identityNameLookupCases,
	"find-by-kind-tags": findByKindTagsCases,
	"changes-since-position": changesSincePositionCases,
	"follow-narrowed-set": followNarrowedSetCases,
	"stated-history-bound": statedHistoryBoundCases,
	"store-refusal": [...storeRefusalCases, ...entityLimitCases],
};

/** Which rows the suite covers, which run locally only, and which are deferred, with the ruling that defers them. */
export const contractSuiteRows = Object.freeze({
	carried: Object.freeze(Object.keys(CASES)),
	localOnly: Object.freeze(["storage-port", "declared-shape-validation"]),
	deferred: Object.freeze({}),
});

/**
 * Registers every case of the rows named - every row entity-api carries when none are named - with the
 * consumer's test runner, each run against a fresh store the harness opens. Every case is registered;
 * none is skipped.
 */
export function registerEntityStoreSuite(register: SuiteRegister, harness: SuiteHarness, rows: readonly string[] = contractSuiteRows.carried): number {
	let count = 0;
	for (const row of rows) {
		const cases = CASES[row];
		if (cases === undefined) throw new Error(`the suite has no row ${row}; its rows are ${contractSuiteRows.carried.join(", ")}`);
		for (const c of cases) {
			register(`${row}: ${c.name}`, () => c.run(harness));
			count++;
		}
	}
	return count;
}
