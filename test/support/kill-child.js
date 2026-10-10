// kill-child - a process that opens a store on a change log file, runs the recovery scenario, prints one
// line for each acknowledged write, and then waits to be killed; it never closes the log or exits itself.
//
// Usage: node kill-child.js <log file> [steps to run]
import { openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { KINDS } from "./local-store.js";
import { runScenario, STEPS, T0 } from "./recovery-scenario.js";

const [file, count] = process.argv.slice(2);
let now = T0;
const clock = { now: () => now, set: (ms) => { now = ms; } };
const opening = openEntityStore({ storage: createFileStoragePort(file), clock, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
if (!opening.opened) {
	process.stdout.write(`${JSON.stringify({ error: opening.refusal })}\n`);
} else {
	for (const step of STEPS.slice(0, count === undefined ? STEPS.length : Number(count))) {
		const [done] = runScenario(opening.store, clock, [step]);
		process.stdout.write(`${JSON.stringify({ ack: done.write.writeId, answer: done.answer })}\n`);
	}
	process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
}
setInterval(() => {}, 1 << 30);
