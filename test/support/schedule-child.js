// schedule-child - EM8's schedule, run on the file port in a process that is then really killed.
//
// With a bound of 1000 ms the child makes a change at 1000 and another at 1900, then at 2000 either
// repeats the second ("repeat") or finds as of position 0 ("find"), acknowledging each answer by appending
// a line to the parent's acknowledgement file, and then waits to be killed; it never closes the log or
// exits itself. The parent reopens the log with the clock set back to 1900.
//
// Usage: node schedule-child.js <log file> <repeat | find> <acknowledgement file>
import { openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { acknowledge } from "./child-process.js";
import { KINDS } from "./local-store.js";
import { SCHEDULE } from "./schedule.js";

const [file, mode, ackFile] = process.argv.slice(2);
let now = 1000;
const opening = openEntityStore({ storage: createFileStoragePort(file), clock: { now: () => now }, historyMs: SCHEDULE.historyMs, maxEntityBytes: 65_536, kinds: KINDS });
if (!opening.opened) {
	acknowledge(ackFile, { error: opening.refusal });
} else {
	const { store } = opening;
	const { first, second } = SCHEDULE;
	acknowledge(ackFile, { step: "first", outcome: store[first.op](first.input, first.write) });
	now = 1900;
	acknowledge(ackFile, { step: "second", outcome: store[second.op](second.input, second.write) });
	now = 2000;
	if (mode === "repeat") acknowledge(ackFile, { step: "repeat of the second at 2000", outcome: store[second.op](second.input, second.write) });
	else acknowledge(ackFile, { step: "find as of 0 at 2000", outcome: store.find({ kind: "note", asOf: 0 }) });
	acknowledge(ackFile, { ready: true });
}
setInterval(() => {}, 1 << 30);
