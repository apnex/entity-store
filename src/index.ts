/**
 * Public surface of entity-store: exactly the capabilities CONTRACT.md lists, and nothing else.
 * openEntityStore - positioned-entity-write, change-provenance, expected-revision-write, repeat-recognition,
 *   identity-name-lookup, find-by-kind-tags, stated-history-bound and store-refusal, with
 *   declared-shape-validation carried from shape-check.
 * createMemoryStoragePort - storage-port, in memory; the file port is `@apnex/entity-store/file-storage`.
 * changes-since-position and follow-narrowed-set are deferred (zorg's D15).
 */
export { openEntityStore } from "./entity-store.js";
export { createMemoryStoragePort, type MemoryStoragePort } from "./memory-storage.js";
export type {
	ChangeRecord,
	ChangeStamp,
	ClockPort,
	CreateInput,
	DeleteAnswer,
	DeleteInput,
	EntityAnswer,
	EntityEnvelope,
	EntityStore,
	EntityTarget,
	FindAnswer,
	FindInput,
	HistoryBoundAnswer,
	JsonObject,
	JsonValue,
	LoadedRecord,
	LogRecord,
	OpeningRefusal,
	OpeningRefusalCode,
	ReadAnswer,
	ReadInput,
	RepeatCheck,
	StorageFault,
	StorageLoad,
	StoragePort,
	StoreOpening,
	StoreOptions,
	StoreOutcome,
	StoreRefusal,
	StoreRefusalCode,
	TimeRecord,
	UpdateInput,
	WriteAnswer,
	WriteContext,
	WriteOperation,
	WriteRecord,
} from "./store-types.js";
