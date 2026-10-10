/**
 * The file storage port (EM15, D24), the one file of entity-store that uses the filesystem, and so the
 * one named for the adapter it is (D31).
 *
 * The change log is JSON Lines in UTF-8, each record one line ending in a newline, after the header line
 * {"log":"entity-store","version":1}. A record is appended with one synchronous write and fdatasync before
 * `append` returns, so before any read sees its change or its answer is sent. On loading, a final line
 * that is incomplete or does not parse is discarded and the file cut back to the last whole record; any
 * earlier line that does not parse stops the store opening, naming the line.
 */
import fs from "node:fs";
import path from "node:path";
import type { LoadedRecord, LogRecord, StorageFault, StorageLoad, StoragePort } from "./store-types.js";

/** The header line, without its newline. */
export const LOG_HEADER = '{"log":"entity-store","version":1}';

/** A storage port over a change log file. */
export interface FileStoragePort extends StoragePort {
	/** The change log's file. */
	readonly file: string;
	/** Closes the file; the port appends nothing more. */
	close(): void;
}

const NEWLINE = 0x0a;

/** Creates a storage port keeping the change log in a file, created with its header when absent. */
export function createFileStoragePort(file: string): FileStoragePort {
	let fd: number | undefined;

	const fault = (code: StorageFault["code"], line: number | null, message: string): StorageLoad => ({ ok: false, fault: { code, line, message } });

	// Writes a fresh header into an absent or empty file, flushed with the directory entry that names it.
	const writeHeader = (): void => {
		const handle = fs.openSync(file, "w");
		try {
			writeWhole(handle, Buffer.from(`${LOG_HEADER}\n`, "utf8"));
			fs.fdatasyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
		syncDirectory(path.dirname(file));
	};

	const cutBackTo = (length: number): void => {
		const handle = fs.openSync(file, "r+");
		try {
			fs.ftruncateSync(handle, length);
			fs.fdatasyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
	};

	return {
		file,
		load(): StorageLoad {
			if (fd !== undefined) throw new Error("the change log is already loaded");
			let bytes: Buffer;
			try {
				if (!fs.existsSync(file)) writeHeader();
				bytes = fs.readFileSync(file);
				if (bytes.length === 0 || (bytes.indexOf(NEWLINE) < 0 && Buffer.from(LOG_HEADER, "utf8").subarray(0, bytes.length).equals(bytes))) {
					// A file created but never given its whole header holds no record; it is given its header again.
					writeHeader();
					bytes = fs.readFileSync(file);
				}
			} catch (error) {
				return fault("log-unwritable", null, `the change log cannot be created or read: ${(error as Error).message}`);
			}

			const headerEnd = bytes.indexOf(NEWLINE);
			if (headerEnd < 0 || !isHeader(bytes.subarray(0, headerEnd))) return fault("log-corrupt", 1, "line 1: the change log does not begin with its header line");

			const records: LoadedRecord[] = [];
			let start = headerEnd + 1;
			let line = 2;
			let keep = bytes.length;
			while (start < bytes.length) {
				const end = bytes.indexOf(NEWLINE, start);
				if (end < 0) {
					// An incomplete final line: its append never finished, so its answer was never sent.
					keep = start;
					break;
				}
				const record = parseLine(bytes.subarray(start, end));
				if (record === undefined) {
					if (end + 1 === bytes.length) {
						keep = start;
						break;
					}
					return fault("log-corrupt", line, `line ${line}: the line does not parse`);
				}
				records.push({ line, record: record.value });
				start = end + 1;
				line++;
			}

			try {
				if (keep < bytes.length) cutBackTo(keep);
				fd = fs.openSync(file, "a");
			} catch (error) {
				return fault("log-unwritable", null, `the change log cannot be opened for appending: ${(error as Error).message}`);
			}
			return { ok: true, records };
		},
		append(record: LogRecord): void {
			if (fd === undefined) throw new Error("the change log is not open: load it first");
			writeWhole(fd, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
			fs.fdatasyncSync(fd);
		},
		close(): void {
			if (fd !== undefined) fs.closeSync(fd);
			fd = undefined;
		},
	};
}

// One synchronous write of the whole line; the loop only finishes a write the system cut short.
function writeWhole(fd: number, buffer: Buffer): void {
	let written = 0;
	while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written);
}

function syncDirectory(directory: string): void {
	let handle: number | undefined;
	try {
		handle = fs.openSync(directory, "r");
		fs.fsyncSync(handle);
	} catch {
		// Some systems cannot sync a directory; the file's own data is already flushed.
	} finally {
		if (handle !== undefined) fs.closeSync(handle);
	}
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseLine(bytes: Buffer): { value: unknown } | undefined {
	try {
		return { value: JSON.parse(decoder.decode(bytes)) as unknown };
	} catch {
		return undefined;
	}
}

function isHeader(bytes: Buffer): boolean {
	const parsed = parseLine(bytes);
	if (parsed === undefined || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return false;
	const header = parsed.value as Record<string, unknown>;
	return Object.keys(header).length === 2 && header.log === "entity-store" && header.version === 1;
}
