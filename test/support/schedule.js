// schedule - the writes of EM8's schedule, shared by schedule-child.js and the tests that kill it: with a
// bound of 1000 ms, a create at 1000 (the first change) and an update of it at 1900 (the second).

const body = (s) => ({ pointer: `https://example.com/${s}`, summary: s });

export const SCHEDULE = {
	historyMs: 1000,
	first: { op: "create", input: { kind: "note", name: "alpha", tags: [], body: body("alpha") }, write: { writer: "alice", writeId: "first" } },
	second: { op: "update", input: { target: { id: "e1.1" }, tags: ["a:b"] }, write: { writer: "bob", writeId: "second" } },
};
