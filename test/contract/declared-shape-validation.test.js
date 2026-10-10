// declared-shape-validation (carried from shape-check) - kinds are supplied by the application as declared
// shapes; a write that does not fit its kind is refused, and no kind is built in (shape-check's SD7; zorg's
// E9). Runs locally only: entity-api does not carry this row.
//
// For every case of shape-check's corpus, read through its public data path, a store is opened with one
// kind whose body shape is the case's shape and the largest size a store allows, 262144 bytes, and an
// entity is created with the case's value as its body. A refused shape makes opening fail with the case's
// problems; a misfit is refused with code misfit and the case's misfits; a fit is accepted. Records are
// compared with the case's in canonical JSON, byte for byte.
import assert from "node:assert/strict";
import { test } from "node:test";
import corpus from "@apnex/shape-check/corpus" with { type: "json" };
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";

const byCodePoint = (a, b) => {
	const x = Array.from(a, (c) => c.codePointAt(0));
	const y = Array.from(b, (c) => c.codePointAt(0));
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
	return x.length - y.length;
};
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
	: v !== null && typeof v === "object" ? `{${Object.keys(v).sort(byCodePoint).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
	: JSON.stringify(v);

test("the corpus is read through shape-check's public data path and holds cases of every verdict", () => {
	assert.ok(corpus.cases.length > 0);
	const verdicts = new Set(corpus.cases.map((c) => c.verdict.verdict));
	assert.deepEqual([...verdicts].sort(), ["fits", "misfit", "shape-refused"]);
});

for (const c of corpus.cases) {
	test(`corpus: ${c.name}`, () => {
		const opening = openEntityStore({ storage: createMemoryStoragePort(), clock: { now: () => 0 }, historyMs: 60_000, maxEntityBytes: 262144, kinds: { kind: c.shape } });
		if (c.verdict.verdict === "shape-refused") {
			assert.equal(opening.opened, false, "a refused shape makes opening fail");
			assert.equal(opening.refusal.code, "shape-refused");
			assert.equal(canonical(opening.refusal.details.problems), canonical(c.verdict.problems), "the case's problems, byte for byte");
			return;
		}
		assert.equal(opening.opened, true, `the store opens: ${JSON.stringify(opening.refusal)}`);
		const outcome = opening.store.create({ kind: "kind", name: "case", tags: [], body: c.value }, { writer: "corpus", writeId: c.name });
		if (c.verdict.verdict === "misfit") {
			assert.equal(outcome.outcome, "refused");
			assert.equal(outcome.refusal.code, "misfit");
			assert.equal(outcome.refusal.part, "entity-store");
			assert.deepEqual(outcome.refusal.details, {});
			assert.equal(canonical(outcome.refusal.misfits), canonical(c.verdict.misfits), "the case's misfits, unchanged, byte for byte");
		} else {
			assert.equal(outcome.outcome, "answered", `a fit is accepted: ${JSON.stringify(outcome.refusal)}`);
			assert.equal(canonical(outcome.answer.entity.body), canonical(c.value), "the body is kept as given");
		}
	});
}
