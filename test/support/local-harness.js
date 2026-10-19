// local-harness - the shared contract suite's harness for a store in this process.
//
// Each session opens a store over a storage port this harness makes - memory by default, or a change log
// file - with a clock the suite sets. A restart abandons the open store without closing anything, as a
// killed process would, and opens a new one on the same storage with the same options.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { createFileStoragePort } from "@apnex/entity-store/file-storage";

/** A harness over memory storage, or over a change log file in a fresh directory when `storage` is "file". */
export function createLocalHarness({ storage = "memory", writer = "alice" } = {}) {
	let ids = 0;
	return {
		async open(options, time) {
			let now = time;
			const clock = { now: () => now };
			const dir = storage === "file" ? fs.mkdtempSync(path.join(os.tmpdir(), "entity-store-suite-")) : undefined;
			const memory = storage === "memory" ? createMemoryStoragePort() : undefined;
			const filePorts = [];
			const port = () => {
				if (memory) return memory;
				filePorts.push(createFileStoragePort(path.join(dir, "changes.log")));
				return filePorts.at(-1);
			};
			const openStore = () => {
				const opening = openEntityStore({ ...options, storage: port(), clock });
				if (!opening.opened) throw new Error(`the store did not open: ${JSON.stringify(opening.refusal)}`);
				return opening.store;
			};
			let store = openStore();
			return {
				setTime(ms) { now = ms; },
				newWriteId() { return `local-write-${++ids}`; },
				async call(operation, input, caller = {}) {
					const write = { writer: caller.writer ?? writer, writeId: caller.writeId ?? `local-write-${++ids}` };
					switch (operation) {
						case "create": return store.create(input, write);
						case "update": return store.update(input, write);
						case "delete": return store.delete(input, write);
						case "read": return store.read(input);
						case "find": return store.find(input);
						case "history-bound": return store.historyBound();
						case "changes": return store.changes(input);
						case "follow": return store.follow(input);
						default: throw new Error(`no operation ${operation}`);
					}
				},
				async restart() {
					// The old file descriptor is left open, as a killed process leaves its file; a new port reads the file afresh.
					store = openStore();
				},
				async close() {
					for (const p of filePorts) p.close();
					if (dir) fs.rmSync(dir, { recursive: true, force: true });
				},
			};
		},
	};
}
