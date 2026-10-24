/**
 * The file storage port (EM15, D24, D68, D69, BL26), the one file of entity-store that uses the filesystem,
 * and so the one named for the adapter it is (D31).
 *
 * The change log is JSON Lines in UTF-8, each record one line ending in a newline, after the header line
 * {"log":"entity-store","version":1}. A record is appended with one synchronous write and fdatasync before
 * `append` returns, so before any read sees its change or its answer is sent. On loading, a final line
 * that is incomplete or does not parse is discarded and the file cut back to the last whole record; any
 * earlier line that does not parse stops the store opening, naming the line.
 *
 * Compaction (`compact`) atomically replaces `file` via `${file}.compact` (opened exclusively with
 * `O_CREAT | O_EXCL | O_WRONLY`, flushed with `fdatasync`, closed, renamed over `file` and directory-synced);
 * when `archiveFile` is given, evicted `change` records (`lastArchivedPosition < position <= base.position`)
 * are appended and flushed to `archiveFile` before `${file}.compact` is written and renamed.
 */
import fs from "node:fs";
import path from "node:path";
import { checkChangeRecordShape, isJsonObject, parseTime } from "./change-log.js";
import type { ChangeRecord, FileStorageOptions, LoadedRecord, LogRecord, StorageFault, StorageLoad, StoragePort } from "./store-types.js";

export type { FileStorageOptions } from "./store-types.js";

/** The header line, without its newline. */
export const LOG_HEADER = '{"log":"entity-store","version":1}';

/** A storage port over a change log file, with an optional archive file for evicted `change` records. */
export interface FileStoragePort extends StoragePort {
	/** The change log's file. */
	readonly file: string;
	/** The archive file for evicted `change` records, when configured. */
	readonly archiveFile?: string;
	/** Closes the file; the port appends or compacts nothing more. */
	close(): void;
}

const NEWLINE = 0x0a;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const INITIAL_TAIL_BYTES = 65_536;
const HEADER_READ_BYTES = 64;

/** Creates a storage port keeping the change log in a file, created with its header when absent. */
export function createFileStoragePort(file: string, options?: FileStorageOptions): FileStoragePort {
	if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
		throw new TypeError("createFileStoragePort options must be an object");
	}
	const archiveFile = options?.archiveFile;
	if (archiveFile !== undefined && (typeof archiveFile !== "string" || archiveFile === "")) {
		throw new TypeError("createFileStoragePort archiveFile must be a non-empty string");
	}
	const compactFile = `${file}.compact`;
	let fd: number | undefined;
	let lastArchivedPosition = 0;
	/** Each active `change` record's serialized JSON line (without trailing newline), keyed by position. */
	const activeChangeLines = new Map<number, string>();

	const fault = (code: StorageFault["code"], line: number | null, message: string): StorageLoad => ({ ok: false, fault: { code, line, message } });

	const checkNotSymlinkOrDirectory = (target: string, what: string): void => {
		const stat = fs.lstatSync(target, { throwIfNoEntry: false });
		if (stat !== undefined && (stat.isSymbolicLink() || stat.isDirectory())) {
			throw new Error(`${what} (${target}) is a symbolic link or a directory`);
		}
	};

	const checkPaths = (): void => {
		checkNotSymlinkOrDirectory(file, "the change log");
		checkNotSymlinkOrDirectory(compactFile, "the compaction scratch file");
		if (archiveFile !== undefined) {
			checkNotSymlinkOrDirectory(archiveFile, "the archive log");
			const resolvedFile = path.resolve(file);
			const resolvedCompact = path.resolve(compactFile);
			const resolvedArchive = path.resolve(archiveFile);
			if (resolvedArchive === resolvedFile || resolvedArchive === resolvedCompact) {
				throw new Error("the archive log path collides with the change log or its compaction scratch file");
			}
			const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
			const archStat = fs.lstatSync(archiveFile, { throwIfNoEntry: false });
			if (fileStat !== undefined && archStat !== undefined && fileStat.dev === archStat.dev && fileStat.ino === archStat.ino) {
				throw new Error("the archive log is linked to the same file as the change log");
			}
		}
	};

	// Writes a fresh header into an absent or empty file, flushed with the directory entry that names it.
	const writeHeaderTo = (target: string): void => {
		checkNotSymlinkOrDirectory(target, "the log file");
		const handle = fs.openSync(target, "w");
		try {
			writeWhole(handle, Buffer.from(`${LOG_HEADER}\n`, "utf8"));
			fs.fdatasyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
		syncDirectory(path.dirname(target));
	};

	const cutBackFileTo = (target: string, length: number): void => {
		const handle = fs.openSync(target, "r+");
		try {
			fs.ftruncateSync(handle, length);
			fs.fdatasyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
	};

	return {
		file,
		...(archiveFile === undefined ? {} : { archiveFile }),
		load(): StorageLoad {
			if (fd !== undefined) throw new Error("the change log is already loaded");
			let bytes: Buffer;
			try {
				checkPaths();
				if (!fs.existsSync(file)) writeHeaderTo(file);
				bytes = fs.readFileSync(file);
				if (bytes.length === 0 || (bytes.indexOf(NEWLINE) < 0 && Buffer.from(LOG_HEADER, "utf8").subarray(0, bytes.length).equals(bytes))) {
					// A file created but never given its whole header holds no record; it is given its header again.
					writeHeaderTo(file);
					bytes = fs.readFileSync(file);
				}
			} catch (error) {
				return fault("log-unwritable", null, `the change log cannot be created or read: ${(error as Error).message}`);
			}

			const headerEnd = bytes.indexOf(NEWLINE);
			if (headerEnd < 0 || !isHeader(bytes.subarray(0, headerEnd))) return fault("log-corrupt", 1, "line 1: the change log does not begin with its header line");

			const records: LoadedRecord[] = [];
			activeChangeLines.clear();
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
				const slice = bytes.subarray(start, end);
				const record = parseLine(slice);
				if (record === undefined) {
					if (end + 1 === bytes.length) {
						keep = start;
						break;
					}
					return fault("log-corrupt", line, `line ${line}: the line does not parse`);
				}
				records.push({ line, record: record.value });
				if (isJsonObject(record.value) && record.value.type === "change" && typeof record.value.position === "number") {
					activeChangeLines.set(record.value.position, decoder.decode(slice));
				}
				start = end + 1;
				line++;
			}

			if (archiveFile !== undefined) {
				const archiveLoaded = loadAndValidateArchive(archiveFile, records, checkPaths, writeHeaderTo, cutBackFileTo);
				if (!archiveLoaded.ok) return archiveLoaded;
				lastArchivedPosition = archiveLoaded.lastArchivedPosition;
			}

			try {
				if (keep < bytes.length) cutBackFileTo(file, keep);
				fd = fs.openSync(file, "a");
			} catch (error) {
				return fault("log-unwritable", null, `the change log cannot be opened for appending: ${(error as Error).message}`);
			}
			return { ok: true, records };
		},
		append(record: LogRecord): void {
			if (fd === undefined) throw new Error("the change log is not open: load it first");
			const text = JSON.stringify(record);
			writeWhole(fd, Buffer.from(`${text}\n`, "utf8"));
			fs.fdatasyncSync(fd);
			if (record.type === "change") activeChangeLines.set(record.position, text);
		},
		compact(records: readonly LogRecord[]): void {
			if (fd === undefined) throw new Error("the change log is not open: load it first");
			checkPaths();
			const first = records[0];
			if (archiveFile !== undefined && first !== undefined && first.type === "base") {
				const targetPos = first.position;
				if (targetPos > lastArchivedPosition) {
					const evictedLines: string[] = [];
					for (let pos = lastArchivedPosition + 1; pos <= targetPos; pos++) {
						const lineText = activeChangeLines.get(pos);
						if (lineText === undefined) throw new Error(`cannot archive missing change record at position ${pos}`);
						evictedLines.push(`${lineText}\n`);
					}
					if (evictedLines.length > 0) {
						const archFd = fs.openSync(archiveFile, "a");
						try {
							writeWhole(archFd, Buffer.from(evictedLines.join(""), "utf8"));
							fs.fdatasyncSync(archFd);
						} finally {
							fs.closeSync(archFd);
						}
					}
					lastArchivedPosition = targetPos;
				}
			}

			const existingCompact = fs.lstatSync(compactFile, { throwIfNoEntry: false });
			if (existingCompact !== undefined) {
				if (existingCompact.isSymbolicLink() || existingCompact.isDirectory()) {
					throw new Error(`the compaction scratch file (${compactFile}) is a symbolic link or a directory`);
				}
				fs.unlinkSync(compactFile);
			}
			const serialized = `${LOG_HEADER}\n${records.map((r) => `${JSON.stringify(r)}\n`).join("")}`;
			const tempFd = fs.openSync(compactFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
			try {
				writeWhole(tempFd, Buffer.from(serialized, "utf8"));
				fs.fdatasyncSync(tempFd);
			} finally {
				fs.closeSync(tempFd);
			}
			fs.closeSync(fd);
			fd = undefined;
			fs.renameSync(compactFile, file);
			syncDirectory(path.dirname(file));
			fd = fs.openSync(file, "a");

			activeChangeLines.clear();
			for (const r of records) {
				if (r.type === "change") activeChangeLines.set(r.position, JSON.stringify(r));
			}
		},
		close(): void {
			if (fd !== undefined) fs.closeSync(fd);
			fd = undefined;
		},
	};
}

/** Validates `archiveFile` in bounded head-and-tail I/O and checks boundary continuity with `activeRecords`. */
function loadAndValidateArchive(
	archiveFile: string,
	activeRecords: readonly LoadedRecord[],
	checkPaths: () => void,
	writeHeaderTo: (target: string) => void,
	cutBackFileTo: (target: string, length: number) => void,
): { ok: true; lastArchivedPosition: number } | { ok: false; fault: StorageFault } {
	const corrupt = (line: number | null, message: string) => ({ ok: false as const, fault: { code: "log-corrupt" as const, line, message } });
	const unwritable = (message: string) => ({ ok: false as const, fault: { code: "log-unwritable" as const, line: null, message } });

	let archFd: number | undefined;
	try {
		checkPaths();
		if (!fs.existsSync(archiveFile)) writeHeaderTo(archiveFile);
		checkPaths();
		archFd = fs.openSync(archiveFile, "r");
		let archSize = fs.fstatSync(archFd).size;
		let headLen = Math.min(HEADER_READ_BYTES, archSize);
		let headBuf = Buffer.alloc(headLen);
		if (headLen > 0) fs.readSync(archFd, headBuf, 0, headLen, 0);

		if (archSize === 0 || (headBuf.indexOf(NEWLINE) < 0 && Buffer.from(LOG_HEADER, "utf8").subarray(0, archSize).equals(headBuf))) {
			fs.closeSync(archFd);
			archFd = undefined;
			writeHeaderTo(archiveFile);
			archFd = fs.openSync(archiveFile, "r");
			archSize = fs.fstatSync(archFd).size;
			headLen = Math.min(HEADER_READ_BYTES, archSize);
			headBuf = Buffer.alloc(headLen);
			fs.readSync(archFd, headBuf, 0, headLen, 0);
		}

		const headerEnd = headBuf.indexOf(NEWLINE);
		if (headerEnd < 0 || !isHeader(headBuf.subarray(0, headerEnd))) {
			return corrupt(1, "line 1: the archive log does not begin with its header line");
		}
		const bodyStart = headerEnd + 1;

		// Extract active `base` (if any on line 2) and active `change` records by position.
		const firstActive = activeRecords[0]?.record;
		const hasBase = isJsonObject(firstActive) && firstActive.type === "base";
		const basePos = hasBase && typeof firstActive.position === "number" && Number.isSafeInteger(firstActive.position) && firstActive.position >= 1 ? firstActive.position : undefined;
		const baseAt = hasBase && typeof firstActive.at === "string" ? firstActive.at : undefined;
		const baseDigest = hasBase && typeof firstActive.digest === "string" ? firstActive.digest : undefined;

		const activeChanges = new Map<number, { at: string; digest: string }>();
		for (const { record } of activeRecords) {
			if (isJsonObject(record) && record.type === "change" && typeof record.position === "number" && typeof record.at === "string" && typeof record.digest === "string") {
				activeChanges.set(record.position, { at: record.at, digest: record.digest });
			}
		}

		// Read backwards from the end of `archiveFile`, cutting back any torn final line and parsing the tail `change` records.
		let windowBytes = INITIAL_TAIL_BYTES;
		let tailRecords: ChangeRecord[] = [];
		let reachedStart = false;

		for (;;) {
			if (archSize <= bodyStart) {
				tailRecords = [];
				reachedStart = true;
				break;
			}
			const from = Math.max(bodyStart, archSize - windowBytes);
			const len = archSize - from;
			const buf = Buffer.alloc(len);
			let read = 0;
			while (read < len) {
				const n = fs.readSync(archFd, buf, read, len - read, from + read);
				if (n === 0) break;
				read += n;
			}
			const lastNl = buf.lastIndexOf(NEWLINE);
			if (buf[len - 1] !== NEWLINE) {
				if (lastNl < 0 && from > bodyStart) {
					windowBytes *= 2;
					continue;
				}
				const keep = from + (lastNl < 0 ? 0 : lastNl + 1);
				fs.closeSync(archFd);
				archFd = undefined;
				cutBackFileTo(archiveFile, keep);
				archFd = fs.openSync(archiveFile, "r");
				archSize = keep;
				continue;
			}
			const prevNl = len >= 2 ? buf.lastIndexOf(NEWLINE, len - 2) : -1;
			if (prevNl < 0 && from > bodyStart) {
				windowBytes *= 2;
				continue;
			}
			const finalStart = prevNl < 0 ? 0 : prevNl + 1;
			const finalParsed = parseLine(buf.subarray(finalStart, len - 1));
			if (finalParsed === undefined) {
				const keep = from + finalStart;
				fs.closeSync(archFd);
				archFd = undefined;
				cutBackFileTo(archiveFile, keep);
				archFd = fs.openSync(archiveFile, "r");
				archSize = keep;
				continue;
			}

			// Split complete lines in `buf` (skipping the partial leading fragment when `from > bodyStart`).
			let lineOffset = 0;
			if (from > bodyStart) {
				const firstNl = buf.indexOf(NEWLINE);
				lineOffset = firstNl + 1;
			}
			const parsedList: ChangeRecord[] = [];
			while (lineOffset < len) {
				const nl = buf.indexOf(NEWLINE, lineOffset);
				if (nl < 0) break;
				const parsed = parseLine(buf.subarray(lineOffset, nl));
				if (parsed === undefined) return corrupt(null, "the archive log contains a line that does not parse");
				const shapeErr = checkChangeRecordShape(parsed.value);
				if (shapeErr !== undefined) return corrupt(null, `the archive log contains an invalid record: ${shapeErr}`);
				const rec = parsed.value as ChangeRecord;
				if (!DIGEST_HEX.test(rec.digest)) return corrupt(null, "the archive log contains a change record whose digest is not 64 lowercase hexadecimal digits");
				parsedList.push(rec);
				lineOffset = nl + 1;
			}
			if (parsedList.length === 0 && from > bodyStart) {
				windowBytes *= 2;
				continue;
			}
			for (let i = 1; i < parsedList.length; i++) {
				if ((parsedList[i] as ChangeRecord).position !== (parsedList[i - 1] as ChangeRecord).position + 1) {
					return corrupt(null, "the archive log's change positions are not contiguous");
				}
			}
			if (from === bodyStart && parsedList.length > 0 && (parsedList[0] as ChangeRecord).position !== 1) {
				return corrupt(null, `the archive log begins at position ${(parsedList[0] as ChangeRecord).position} instead of 1`);
			}

			const lastRec = parsedList[parsedList.length - 1] as ChangeRecord;
			// In the crash-before-rename branch (`hasBase && basePos !== undefined && lastRec.position > basePos`),
			// ensure our tail window reaches down to `basePos` so we can verify the boundary record at `basePos`.
			if (hasBase && basePos !== undefined && lastRec.position > basePos && (parsedList[0] as ChangeRecord).position > basePos && from > bodyStart) {
				windowBytes *= 2;
				continue;
			}
			tailRecords = parsedList;
			reachedStart = from === bodyStart;
			break;
		}

		if (tailRecords.length === 0) {
			if (hasBase) return corrupt(null, "the active change log starts with a base record, but the archive log holds no change records");
			return { ok: true, lastArchivedPosition: 0 };
		}

		const lastArchived = tailRecords[tailRecords.length - 1] as ChangeRecord;
		if (hasBase) {
			// If `firstActive` is a malformed `base` record, let `recoverLog` report its exact line 2 fault unless its boundary fields are readable.
			if (basePos === undefined || baseAt === undefined || baseDigest === undefined || parseTime(baseAt) === undefined || !DIGEST_HEX.test(baseDigest)) {
				return { ok: true, lastArchivedPosition: lastArchived.position };
			}
			if (lastArchived.position < basePos) {
				return corrupt(null, `the archive log ends at position ${lastArchived.position}, before the active log's base position ${basePos}`);
			}
			if (lastArchived.position === basePos) {
				if (lastArchived.at !== baseAt || lastArchived.digest !== baseDigest) {
					return corrupt(null, "the archive log's final change record does not match the active log's base record (at or digest mismatch)");
				}
				return { ok: true, lastArchivedPosition: basePos };
			}
			// Crash-before-rename branch: `lastArchived.position > basePos`.
			const atBase = tailRecords.find((r) => r.position === basePos);
			if (atBase === undefined || atBase.at !== baseAt || atBase.digest !== baseDigest) {
				return corrupt(null, "the archive log's record at the base position does not match the active log's base record");
			}
			const nextInActive = activeChanges.get(basePos + 1);
			const lastInActive = activeChanges.get(lastArchived.position);
			if (nextInActive === undefined || lastInActive === undefined || lastInActive.at !== lastArchived.at || lastInActive.digest !== lastArchived.digest) {
				return corrupt(null, "the archive log extends past the active log's base record without matching the active log's uncompacted changes");
			}
			return { ok: true, lastArchivedPosition: lastArchived.position };
		}

		// Active log has no `base` record: `archiveFile` may only hold records from an interrupted first compaction that match `activeChanges`.
		const firstInActive = activeChanges.get(1);
		const lastInActive = activeChanges.get(lastArchived.position);
		if ((reachedStart && (tailRecords[0] as ChangeRecord).position !== 1) || firstInActive === undefined || lastInActive === undefined || lastInActive.at !== lastArchived.at || lastInActive.digest !== lastArchived.digest) {
			return corrupt(null, "the archive log holds change records that do not match the uncompacted active change log");
		}
		return { ok: true, lastArchivedPosition: lastArchived.position };
	} catch (error) {
		return unwritable(`the archive log cannot be created or read: ${(error as Error).message}`);
	} finally {
		if (archFd !== undefined) fs.closeSync(archFd);
	}
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
