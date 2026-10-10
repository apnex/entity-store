/**
 * The memory storage port (EM15): the change log's records kept in memory, as JSON text, so nothing a
 * caller holds can change them. A store opened again over the same port recovers them as it would from a
 * file; each record is numbered with the line it would have in the file, the header being line 1.
 */
import type { LogRecord, StoragePort, StorageLoad } from "./store-types.js";

/** A storage port in memory, which can also list the records it holds. */
export interface MemoryStoragePort extends StoragePort {
	/** A copy of every record held, in order. */
	records(): LogRecord[];
}

/** Creates a storage port that keeps the change log in memory; nothing it holds outlives the process. */
export function createMemoryStoragePort(): MemoryStoragePort {
	const lines: string[] = [];
	return {
		load(): StorageLoad {
			return { ok: true, records: lines.map((text, i) => ({ line: i + 2, record: JSON.parse(text) as unknown })) };
		},
		append(record: LogRecord): void {
			lines.push(JSON.stringify(record));
		},
		records(): LogRecord[] {
			return lines.map((text) => JSON.parse(text) as LogRecord);
		},
	};
}
