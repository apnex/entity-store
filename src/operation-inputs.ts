/**
 * The input shapes of the store's operations, exactly as EM10, EM16 and EM17 declare them, in shape-check's dialect.
 * Remotely, operation-call judges an input against these before the store sees it; locally, the store
 * judges each input against them and throws a TypeError for one that does not fit, since a local caller
 * passing a malformed input has made a programming error, for which EM9 names no refusal.
 */
import { prepareShapeDocument, SHAPE_DIALECT_ID, type JsonInput, type ShapeMisfit } from "@apnex/shape-check";

const target = { type: "object", additionalProperties: false, properties: { id: { type: "string" }, kind: { type: "string" }, name: { type: "string" } } };
const tags = { type: "array", items: { type: "string" } };

/** EM10's input shapes, by operation, EM16's for `changes` and EM17's for `follow`. */
export const OPERATION_INPUT_SHAPES = {
	create: { type: "object", required: ["kind", "name", "tags", "body"], additionalProperties: false, properties: { kind: { type: "string" }, name: { type: "string" }, tags, body: {} } },
	update: { type: "object", required: ["target"], additionalProperties: false, properties: { target, expectedRevision: { type: "integer" }, name: { type: "string" }, tags, body: {} } },
	delete: { type: "object", required: ["target"], additionalProperties: false, properties: { target, expectedRevision: { type: "integer" } } },
	read: { type: "object", required: ["target"], additionalProperties: false, properties: { target } },
	find: { type: "object", required: ["kind"], additionalProperties: false, properties: { kind: { type: "string" }, tags, after: { type: "string" }, asOf: { type: "integer" } } },
	changes: { type: "object", required: ["since"], additionalProperties: false, properties: { since: { type: "integer" } } },
	follow: { type: "object", required: ["kind", "since"], additionalProperties: false, properties: { kind: { type: "string" }, tags, since: { type: "integer" } } },
	// D4, D5: each write's input is then judged against its own operation's shape (requireChangeWriteShapes).
	change: {
		type: "object",
		required: ["writes"],
		additionalProperties: false,
		properties: {
			writes: { type: "array", items: { type: "object", required: ["operation", "input"], additionalProperties: false, properties: { operation: { enum: ["create", "update", "delete"] }, input: { type: "object" } } } },
			expectedPosition: { type: "integer" },
			note: {},
		},
	},
} as const;

export type InputOperation = keyof typeof OPERATION_INPUT_SHAPES;

const prepared = new Map<InputOperation, (value: JsonInput) => readonly ShapeMisfit[]>();
for (const [operation, shape] of Object.entries(OPERATION_INPUT_SHAPES) as [InputOperation, object][]) {
	const document = prepareShapeDocument({ $schema: SHAPE_DIALECT_ID, ...shape } as JsonInput);
	if (!document.accepted) throw new Error(`the ${operation} input shape is refused by shape-check`);
	prepared.set(operation, (value) => {
		const verdict = document.judge(value);
		return verdict.verdict === "misfit" ? verdict.misfits : [];
	});
}

/** Throws a TypeError naming every misfit when an input does not fit its operation's shape. */
export function requireInputShape(operation: InputOperation, input: unknown): void {
	const misfits = (prepared.get(operation) as (value: JsonInput) => readonly ShapeMisfit[])(input as JsonInput);
	if (misfits.length > 0) {
		const error = new TypeError(`the ${operation} input does not fit its shape: ${misfits.map((m) => `${m.pointer || "/"} ${m.fit}`).join("; ")}`);
		(error as TypeError & { misfits: readonly ShapeMisfit[] }).misfits = misfits;
		throw error;
	}
}

/**
 * Throws a TypeError naming every misfit, each pointer from the change's input, when a write of a change that fits
 * change's shape holds an input that does not fit its operation's shape (D4, D5).
 */
export function requireChangeWriteShapes(writes: readonly { operation: "create" | "update" | "delete"; input: unknown }[]): void {
	const misfits: ShapeMisfit[] = [];
	for (const [index, write] of writes.entries()) {
		const found = (prepared.get(write.operation) as (value: JsonInput) => readonly ShapeMisfit[])(write.input as JsonInput);
		for (const misfit of found) misfits.push({ ...misfit, pointer: `/writes/${index}/input${misfit.pointer}` });
	}
	if (misfits.length > 0) {
		const error = new TypeError(`the change input does not fit its shape: ${misfits.map((m) => `${m.pointer} ${m.fit}`).join("; ")}`);
		(error as TypeError & { misfits: readonly ShapeMisfit[] }).misfits = misfits;
		throw error;
	}
}
