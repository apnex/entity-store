/**
 * The input shapes of the store's operations, exactly as EM10 declares them, in shape-check's dialect.
 * Remotely, operation-call judges an input against these before the store sees it; locally, the store
 * judges each input against them and throws a TypeError for one that does not fit, since a local caller
 * passing a malformed input has made a programming error, for which EM9 names no refusal.
 */
import { prepareShapeDocument, SHAPE_DIALECT_ID, type JsonInput, type ShapeMisfit } from "@apnex/shape-check";

const target = { type: "object", additionalProperties: false, properties: { id: { type: "string" }, kind: { type: "string" }, name: { type: "string" } } };
const tags = { type: "array", items: { type: "string" } };

/** EM10's input shapes, by operation. */
export const OPERATION_INPUT_SHAPES = {
	create: { type: "object", required: ["kind", "name", "tags", "body"], additionalProperties: false, properties: { kind: { type: "string" }, name: { type: "string" }, tags, body: {} } },
	update: { type: "object", required: ["target"], additionalProperties: false, properties: { target, expectedRevision: { type: "integer" }, name: { type: "string" }, tags, body: {} } },
	delete: { type: "object", required: ["target"], additionalProperties: false, properties: { target, expectedRevision: { type: "integer" } } },
	read: { type: "object", required: ["target"], additionalProperties: false, properties: { target } },
	find: { type: "object", required: ["kind"], additionalProperties: false, properties: { kind: { type: "string" }, tags, after: { type: "string" }, asOf: { type: "integer" } } },
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
