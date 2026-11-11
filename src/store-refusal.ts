/**
 * The store's refusal records (EM9): exactly `part`, `code`, `what`, `why`, `fix` and `details`, and
 * `misfits` on a misfit only, shape-check's records unchanged. A string `details` takes from an input is
 * cut to its first 128 code points, and `details` then holds `"truncated": true`; the sentences repeat no
 * input string.
 */
import type { JsonObject, JsonValue, ShapeMisfit } from "@apnex/shape-check";

/** The first 128 code points of a string, and whether it was cut (EM9). */
export function cutTo128(text: string): { text: string; truncated: boolean } {
	const points = Array.from(text);
	return points.length > 128 ? { text: points.slice(0, 128).join(""), truncated: true } : { text, truncated: false };
}
import type { StoreRefusal, StoreRefusalCode } from "./store-types.js";

const TEXT: { [code in StoreRefusalCode]: { what: string; why: string; fix: string } } = {
	"note-not-plain": {
		what: "The change's note is not plain JSON.",
		why: "A note is kept and served as data, read without running any of the application's code: null, booleans, finite numbers, strings, and plain arrays and plain objects of them, through their own enumerable data properties.",
		fix: "Give the note as plain JSON data, or give no note.",
	},
	"identity-reused": {
		what: "The write identity names an earlier change, made with a different request.",
		why: "A write identity names one request while its change is within the history bound, so a repeat must be the same request from the same writer.",
		fix: "Send the request the identity was first used for, or give this request a new write identity.",
	},
	"writer-too-long": {
		what: "The writer is longer than 1024 Unicode code points.",
		why: "Every change must fit one page of changes, and the change a delete makes carries its writer whole.",
		fix: "Name the writer in at most 1024 code points.",
	},
	"empty-change": {
		what: "The change holds no write.",
		why: "A change is one or more writes taking one position.",
		fix: "Give the change at least one write.",
	},
	"too-many-writes": {
		what: "The change holds more writes than a change may.",
		why: "A change holds at most 2000 writes, so the page of changes holding it stays within what a carrier admits.",
		fix: "Split the work into changes of at most 2000 writes each.",
	},
	"note-too-deep": {
		what: "The change's note nests more than 16 levels.",
		why: "A note is carried on an item of changes and follow, which bounds its depth.",
		fix: "Nest the note at most 16 levels.",
	},
	"note-too-large": {
		what: "The change's note is larger than 524288 bytes of canonical JSON.",
		why: "A note is kept in its change record and carried on an item of changes and follow, which bounds its size.",
		fix: "Make the note smaller, or split the change so each part's note fits.",
	},
	"note-unsafe-number": {
		what: "The change's note holds an integer more than 9007199254740991 from zero.",
		why: "A note is carried on an item of changes and follow, and AGP cannot carry such an integer, so no remote reader could read past the change.",
		fix: "Write the number as a string, or keep it within 9007199254740991 of zero.",
	},
	"position-moved": {
		what: "The store's position is not the one the change expected.",
		why: "Another change landed after the position the change names.",
		fix: "Read the changes since the position named, decide whether the change still applies, and send it naming the store's position.",
	},
	"unknown-kind": {
		what: "The kind is not one this store was given.",
		why: "The store keeps only the kinds the application declared when it opened the store.",
		fix: "Name one of the store's kinds.",
	},
	"invalid-position": {
		what: "The position is below 0 or above the store's position.",
		why: "A find answers as of, and changes are given after, a position from 0, the empty store, to the store's own position.",
		fix: "Name a position from 0 to the store's position; a find may name none, to ask as of the store's position.",
	},
	"position-not-held": {
		what: "The position is no longer held.",
		why: "The change after that position is outside the history bound, so the store can neither answer as of it nor give the changes after it.",
		fix: "Read the current state afresh, as of the store's position, and carry on from that position.",
	},
	"invalid-target": {
		what: "The target is neither exactly an identity nor exactly a kind and a name.",
		why: "A target names one entity, by its identity alone or by its kind and name together.",
		fix: "Give a target of exactly {\"id\"} or exactly {\"kind\", \"name\"}.",
	},
	"empty-update": {
		what: "The update names none of name, tags and body.",
		why: "An update changes at least one of an entity's name, tags and body.",
		fix: "Name at least one of name, tags and body.",
	},
	"duplicate-target": {
		what: "Two writes of the change target one entity.",
		why: "A change writes each entity at most once, judged by identity or by kind and name as the writes before it leave the names.",
		fix: "Combine the writes to the entity into one, or make them in separate changes.",
	},
	"not-found": {
		what: "No entity that is not deleted matches the target.",
		why: "An update or delete changes an entity the store holds now.",
		fix: "Read or find the entity to learn its current identity or name, then try again.",
	},
	"revision-moved": {
		what: "The entity's revision is not the one the write expected.",
		why: "Another change wrote the entity after the revision the write names.",
		fix: "Read the entity again, decide whether the write still applies, and send it naming the current revision.",
	},
	"invalid-name": {
		what: "The name does not match ^[a-z0-9][a-z0-9-]{0,62}$.",
		why: "A name is a handle: lower-case ASCII letters, digits and hyphens, starting with a letter or digit, at most 63 characters.",
		fix: "Choose a name that matches the pattern.",
	},
	"name-taken": {
		what: "Another entity of the kind holds the name.",
		why: "Names are unique within a kind among entities that are not deleted.",
		fix: "Choose another name, or change the entity that holds it.",
	},
	"too-many-tags": {
		what: "The write lists more tags than an entity may carry.",
		why: "An entity carries at most 32 tags.",
		fix: "List at most 32 tags.",
	},
	"invalid-tag": {
		what: "A tag is not a key and a value, each matching ^[a-z0-9][a-z0-9-]{0,62}$, joined by a colon.",
		why: "Tags are key:value strings whose parts follow the name pattern.",
		fix: "Write each tag as key:value, with each part matching the pattern.",
	},
	"duplicate-tag": {
		what: "The write lists one tag twice.",
		why: "An entity's tags are a set.",
		fix: "List each tag once.",
	},
	misfit: {
		what: "The body does not fit the kind's body shape.",
		why: "Every body is judged against the shape its kind declares, after an update is applied.",
		fix: "Change the body as each misfit record says.",
	},
	"entity-too-large": {
		what: "The entity the write would leave is larger than this store allows.",
		why: "Entities are small: the store refuses an envelope larger, in canonical JSON, than the size the application gave it.",
		fix: "Make the body, name or tags smaller, and keep large content elsewhere, referenced from the body.",
	},
	"entity-too-deep": {
		what: "The entity the write would leave nests more than 27 levels, counting the envelope as the first.",
		why: "Every entity must cross AGP inside the answers that carry it, which bounds its depth.",
		fix: "Nest the body at most 26 levels.",
	},
	"unsafe-number": {
		what: "The entity the write would leave holds an integer more than 9007199254740991 from zero.",
		why: "AGP cannot carry such an integer, so the entity could not be read remotely.",
		fix: "Write the number as a string, or keep it within 9007199254740991 of zero.",
	},
	"change-too-large": {
		what: "The change record the change would append is larger than 8388608 bytes of canonical JSON.",
		why: "A page of changes or follow holding the change must stay within the 16 MiB a carrier admits.",
		fix: "Split the change into smaller changes, or make its entities or its note smaller.",
	},
};

/** Copies a details value, cutting every string to 128 code points, and reports whether any was cut. */
// The walk keeps its own stack, so details of any depth are copied without recursion.
function cutStrings(value: JsonValue, cut: { truncated: boolean }): JsonValue {
	const copyOne = (item: JsonValue): JsonValue => {
		if (typeof item === "string") {
			const result = cutTo128(item);
			if (result.truncated) cut.truncated = true;
			return result.text;
		}
		if (Array.isArray(item)) return new Array<JsonValue>(item.length);
		if (item !== null && typeof item === "object") return {};
		return item;
	};
	const root = copyOne(value);
	const stack: { from: JsonValue[] | JsonObject; to: JsonValue[] | JsonObject }[] = [];
	if (root !== null && typeof root === "object") stack.push({ from: value as JsonValue[] | JsonObject, to: root });
	while (stack.length > 0) {
		const { from, to } = stack.pop() as { from: JsonValue[] | JsonObject; to: JsonValue[] | JsonObject };
		if (Array.isArray(from)) {
			// As Array.prototype.map did, a hole stays a hole.
			for (let i = 0; i < from.length; i++) {
				if (!(i in from)) continue;
				const made = copyOne(from[i] as JsonValue);
				(to as JsonValue[])[i] = made;
				if (made !== null && typeof made === "object") stack.push({ from: from[i] as JsonValue[] | JsonObject, to: made });
			}
			continue;
		}
		for (const [name, member] of Object.entries(from)) {
			const made = copyOne(member);
			// defineProperty, so a member named __proto__ is copied as a member and never sets a prototype.
			Object.defineProperty(to, name, { value: made, enumerable: true, writable: true, configurable: true });
			if (made !== null && typeof made === "object") stack.push({ from: member as JsonValue[] | JsonObject, to: made });
		}
	}
	return root;
}

/**
 * A refusal record. `fromInput` holds the details taken from an input, whose strings are cut to 128 code
 * points; `own` holds the facts the store supplies itself.
 */
export function storeRefusal(code: StoreRefusalCode, fromInput: JsonObject = {}, own: JsonObject = {}, misfits?: readonly ShapeMisfit[]): StoreRefusal {
	const cut = { truncated: false };
	const details = { ...(cutStrings(fromInput, cut) as JsonObject), ...own };
	if (cut.truncated) details.truncated = true;
	const refusal: StoreRefusal = { part: "entity-store", code, ...TEXT[code], details };
	if (misfits !== undefined) refusal.misfits = misfits.map((m) => ({ ...m }));
	return refusal;
}
