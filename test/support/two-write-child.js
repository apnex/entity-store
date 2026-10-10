// two-write-child - writes the memory port's change of two writes to a change log file, then waits to be
// killed holding a store open on it; it never closes the log or exits itself.
//
// The child runs the recovery scenario on a memory port, appends the memory port's two-write fixture,
// writes every record the memory port holds to the change log file through the file port, opens a store
// on that file, and acknowledges what the store holds by appending a line to the parent's
// acknowledgement file.
//
// Usage: node two-write-child.js <log file> <acknowledgement file>
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";
import { acknowledge } from "./child-process.js";
import { KINDS } from "./local-store.js";
import { appendTwoWriteChange, runScenario, snapshot, T0 } from "./recovery-scenario.js";

const [file, ackFile] = process.argv.slice(2);
let now = T0;
const clock = { now: () => now, set: (ms) => { now = ms; } };
const options = { clock, historyMs: 60_000, maxEntityBytes: 65_536, kinds: KINDS };

const memory = createMemoryStoragePort();
const fixture = openEntityStore({ ...options, storage: memory });
const done = runScenario(fixture.store, clock);
const pair = await appendTwoWriteChange(memory, fixture.store);

const writer = createFileStoragePort(file);
const loaded = writer.load();
if (!loaded.ok) {
	acknowledge(ackFile, { error: loaded.fault });
} else {
	for (const record of memory.records()) writer.append(record);
	writer.close();
	const opening = openEntityStore({ ...options, storage: createFileStoragePort(file) });
	if (!opening.opened) acknowledge(ackFile, { error: opening.refusal });
	else {
		acknowledge(ackFile, { done: done.map((d) => ({ writeId: d.write.writeId, answer: d.answer })), pair, snapshot: snapshot(opening.store) });
		acknowledge(ackFile, { ready: true });
	}
}
setInterval(() => {}, 1 << 30);
