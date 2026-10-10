// kill-child - a process that opens a store on a change log file, runs the recovery scenario, acknowledges
// each acknowledged write by appending a line to the parent's acknowledgement file, and then waits to be
// killed; it never closes the log or exits itself.
//
// Usage: node kill-child.js <log file> <steps to run> <acknowledgement file>
import { openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { acknowledge } from "./child-process.js";
import { KINDS } from "./local-store.js";
import { runScenario, STEPS, T0 } from "./recovery-scenario.js";

const [file, count, ackFile] = process.argv.slice(2);
let now = T0;
const clock = { now: () => now, set: (ms) => { now = ms; } };
const opening = openEntityStore({ storage: createFileStoragePort(file), clock, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS });
if (!opening.opened) {
	acknowledge(ackFile, { error: opening.refusal });
} else {
	for (const step of STEPS.slice(0, Number(count))) {
		const [done] = runScenario(opening.store, clock, [step]);
		acknowledge(ackFile, { ack: done.write.writeId, answer: done.answer });
	}
	acknowledge(ackFile, { ready: true });
}
setInterval(() => {}, 1 << 30);
