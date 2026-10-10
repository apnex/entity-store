// recovery-scenario - the writes EM15's recovery test names, made against any store, and the checks that a
// store recovered from the same storage holds everything they left.
//
// The scenario makes a create, a rename, a delete, a name taken again after its delete, a repeated delete,
// and a repeat at a later time, which appends a time record; each step names the write identity it used,
// so a recovered store can be asked to repeat it.

export const T0 = Date.UTC(2026, 9, 9, 10, 0, 0, 0);
const body = (s) => ({ pointer: `https://example.com/${s}`, summary: s });

/** The steps, in order: the time to set, the operation, its input and the write identity and writer. */
export const STEPS = [
	{ at: T0, op: "create", input: { kind: "note", name: "alpha", tags: ["t:a"], body: body("alpha") }, write: { writer: "alice", writeId: "s1" } },
	{ at: T0 + 10, op: "create", input: { kind: "note", name: "beta", tags: [], body: body("beta") }, write: { writer: "bob", writeId: "s2" } },
	{ at: T0 + 20, op: "update", input: { target: { id: "e1.1" }, name: "alpha-renamed" }, write: { writer: "carol", writeId: "s3" } },
	{ at: T0 + 30, op: "delete", input: { target: { kind: "note", name: "beta" } }, write: { writer: "bob", writeId: "s4" } },
	{ at: T0 + 40, op: "delete", input: { target: { kind: "note", name: "beta" } }, write: { writer: "bob", writeId: "s4" }, repeat: true },
	{ at: T0 + 50, op: "create", input: { kind: "note", name: "beta", tags: ["t:b"], body: body("beta-again") }, write: { writer: "alice", writeId: "s5" } },
	{ at: T0 + 60, op: "update", input: { target: { kind: "note", name: "alpha-renamed" }, body: { summary: "changed" }, expectedRevision: 2 }, write: { writer: "alice", writeId: "s6" } },
	{ at: T0 + 70, op: "create", input: { kind: "any", name: "other-kind", tags: [], body: [1, "two", null] }, write: { writer: "dave", writeId: "s7" } },
];

/** Runs the steps, setting the clock before each, and returns each step with its answer. */
export function runScenario(store, clock, steps = STEPS) {
	return steps.map((step) => {
		clock.set(step.at);
		const outcome = store[step.op](step.input, step.write);
		if (outcome.outcome !== "answered") throw new Error(`step ${step.write.writeId} was refused: ${JSON.stringify(outcome.refusal)}`);
		return { ...step, answer: outcome.answer };
	});
}

/** Everything a reader can see of a store: its position, and every entity of each kind with its envelope. */
export function snapshot(store) {
	const position = store.historyBound().answer.position;
	const kinds = {};
	for (const kind of ["note", "any"]) kinds[kind] = store.find({ kind }).answer.entries;
	return { position, kinds };
}

/**
 * Checks that a recovered store holds what the scenario left: the same snapshot, every repeat recognised
 * with its first answer and no position taken, and the next change taking the next position.
 */
export function checkRecovered(assert, store, clock, done, before) {
	assert.deepEqual(snapshot(store), before, "every entity, revision, position and writer is as it was");
	clock.set(T0 + 100);
	for (const step of done) {
		const again = store[step.op](step.input, step.write);
		assert.deepEqual(again, { outcome: "answered", answer: step.answer }, `the repeat of ${step.write.writeId} is recognised after recovery`);
	}
	assert.equal(store.historyBound().answer.position, before.position, "no repeat took a position");
	const next = store.create({ kind: "note", name: "after", tags: [], body: body("after") }, { writer: "erin", writeId: "next" });
	assert.equal(next.answer.position, before.position + 1, "the next change takes the next position");
	assert.equal(next.answer.entity.id, `e${before.position + 1}.1`);
}
