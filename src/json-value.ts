/**
 * JSON values as the store holds them, and the measures the target applies to them: canonical JSON and its
 * size in UTF-8 bytes (shape-check's SD4), nesting depth (EM10), and the first integer AGP cannot carry, in
 * SD5's pointer order (EM9).
 *
 * Every walk over a value here keeps its own stack rather than recursing, so a value of any depth that a
 * caller can build - an input of thousands of levels included - is walked to the end and reaches the
 * store's checks in their declared order, instead of overflowing the runtime's call stack.
 */

/** Any JSON value, as parsed from JSON text. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [name: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [name: string]: JsonValue };

/** The largest distance from zero of an integer AGP carries. */
export const SAFE_INTEGER_LIMIT = 9007199254740991;

/** True for a JSON object, false for null, arrays and scalars. */
export function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compares two strings by Unicode code point, not by UTF-16 code unit. */
export function compareCodePoints(a: string, b: string): number {
	const x = a[Symbol.iterator]();
	const y = b[Symbol.iterator]();
	for (;;) {
		const p = x.next();
		const q = y.next();
		if (p.done) return q.done ? 0 : -1;
		if (q.done) return 1;
		const d = (p.value.codePointAt(0) ?? 0) - (q.value.codePointAt(0) ?? 0);
		if (d !== 0) return d;
	}
}

/** True when a value is JSON: null, a boolean, a finite number, a string, or arrays and plain objects of them. */
/**
 * True when a value is JSON: null, a boolean, a finite number, a string, or arrays and plain objects of them.
 * A value holding itself is not JSON. The walk keeps its own stack, so depth alone never makes it false.
 */
export function isJson(value: unknown): value is JsonValue {
	// Each entry is a value to judge, or the exit marker of a container whose members have all been pushed.
	const stack: { value: unknown; exit: boolean }[] = [{ value, exit: false }];
	const open = new Set<object>();
	while (stack.length > 0) {
		const { value: item, exit } = stack.pop() as { value: unknown; exit: boolean };
		if (exit) {
			open.delete(item as object);
			continue;
		}
		if (item === null || typeof item === "boolean" || typeof item === "string") continue;
		if (typeof item === "number") {
			if (!Number.isFinite(item)) return false;
			continue;
		}
		if (typeof item !== "object") return false;
		if (open.has(item)) return false;
		let members: unknown[];
		if (Array.isArray(item)) {
			// As Array.prototype.every did, a hole is passed over.
			members = [];
			for (let i = 0; i < item.length; i++) if (i in item) members.push(item[i]);
		} else {
			const proto = Object.getPrototypeOf(item);
			if (proto !== Object.prototype && proto !== null) return false;
			members = Object.values(item);
		}
		open.add(item);
		stack.push({ value: item, exit: true });
		for (let i = members.length - 1; i >= 0; i--) stack.push({ value: members[i], exit: false });
	}
	return true;
}

/** Canonical JSON (SD4): no whitespace, properties by code point, strings and numbers as JSON.stringify writes them. */
export function canonicalJson(value: JsonValue): string {
	const out: string[] = [];
	// Each entry is text to write as it stands, or a value to write; entries are popped in writing order.
	const stack: ({ text: string } | { value: JsonValue | undefined })[] = [{ value }];
	while (stack.length > 0) {
		const entry = stack.pop() as { text: string } | { value: JsonValue | undefined };
		if ("text" in entry) {
			out.push(entry.text);
			continue;
		}
		const item = entry.value;
		if (Array.isArray(item)) {
			out.push("[");
			stack.push({ text: "]" });
			for (let i = item.length - 1; i >= 0; i--) {
				// A hole writes nothing between its commas, as Array.prototype.map and join did.
				if (i in item) stack.push({ value: item[i] as JsonValue });
				if (i > 0) stack.push({ text: "," });
			}
		} else if (item !== null && typeof item === "object") {
			const names = Object.keys(item).sort(compareCodePoints);
			out.push("{");
			stack.push({ text: "}" });
			for (let i = names.length - 1; i >= 0; i--) {
				const name = names[i] as string;
				stack.push({ value: item[name] as JsonValue });
				stack.push({ text: `${i > 0 ? "," : ""}${JSON.stringify(name)}:` });
			}
		} else if (item !== undefined) out.push(JSON.stringify(item));
	}
	return out.join("");
}

/** The UTF-8 encoding of a string, a lone surrogate written as U+FFFD as the encoding standard does. */
export function utf8Encode(text: string): Uint8Array {
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		let c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const d = text.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
				i++;
			} else c = 0xfffd;
		} else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
		if (c < 0x80) bytes.push(c);
		else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return Uint8Array.from(bytes);
}

/** The size in UTF-8 bytes of a string. */
export function utf8ByteLength(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

/** The size in bytes of a value's canonical JSON. */
export function canonicalSize(value: JsonValue): number {
	return utf8ByteLength(canonicalJson(value));
}

/** Levels of nesting: 0 for a scalar, and one more than its deepest member for an array or object. */
export function nestingDepth(value: JsonValue): number {
	let deepest = 0;
	// Each entry is a value and the level it would be at if it is an array or object, the value itself at 1.
	const stack: { value: JsonValue; level: number }[] = [{ value, level: 1 }];
	while (stack.length > 0) {
		const { value: item, level } = stack.pop() as { value: JsonValue; level: number };
		if (item === null || typeof item !== "object") continue;
		if (level > deepest) deepest = level;
		for (const member of Object.values(item)) stack.push({ value: member, level: level + 1 });
	}
	return deepest;
}

/** Escapes one JSON pointer token (RFC 6901). */
function pointerToken(token: string): string {
	return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * The pointer of the first integer more than 9007199254740991 from zero, in SD5's order - array indices as
 * numbers, names by code point, a pointer before its descendants - or undefined when there is none.
 */
export function firstUnsafeInteger(value: JsonValue, at = ""): string | undefined {
	// Each entry holds its parent's entry and its own token, so a pointer is written only for the place found.
	interface Place { value: JsonValue; parent: Place | undefined; token: string }
	const stack: Place[] = [{ value, parent: undefined, token: "" }];
	while (stack.length > 0) {
		const place = stack.pop() as Place;
		const item = place.value;
		if (typeof item === "number") {
			if (!Number.isInteger(item) || Math.abs(item) <= SAFE_INTEGER_LIMIT) continue;
			const tokens: string[] = [];
			for (let p: Place | undefined = place; p?.parent !== undefined; p = p.parent) tokens.push(p.token);
			return at + tokens.reverse().map((token) => `/${token}`).join("");
		}
		if (Array.isArray(item)) {
			for (let i = item.length - 1; i >= 0; i--) stack.push({ value: item[i] as JsonValue, parent: place, token: String(i) });
		} else if (item !== null && typeof item === "object") {
			const names = Object.keys(item).sort(compareCodePoints);
			for (let i = names.length - 1; i >= 0; i--) {
				const name = names[i] as string;
				stack.push({ value: item[name] as JsonValue, parent: place, token: pointerToken(name) });
			}
		}
	}
	return undefined;
}

/**
 * A deep copy of a JSON value, so nothing a caller holds can change what the store holds. It copies as
 * JSON text would carry the value: -0 becomes 0, an array's hole becomes null, and a member named
 * __proto__ is copied as a member.
 */
export function copyJson<T extends JsonValue>(value: T): T {
	const copyOne = (item: JsonValue | undefined): JsonValue => {
		if (item === undefined) return null;
		if (typeof item === "number") return Object.is(item, -0) ? 0 : item;
		if (item === null || typeof item !== "object") return item;
		return Array.isArray(item) ? new Array<JsonValue>(item.length) : {};
	};
	const root = copyOne(value);
	// Each entry is a container from the value and its copy, whose members are still to be copied.
	const stack: { from: JsonValue[] | JsonObject; to: JsonValue[] | JsonObject }[] = [];
	if (root !== null && typeof root === "object") stack.push({ from: value as JsonValue[] | JsonObject, to: root });
	while (stack.length > 0) {
		const { from, to } = stack.pop() as { from: JsonValue[] | JsonObject; to: JsonValue[] | JsonObject };
		const names = Array.isArray(from) ? Array.from({ length: from.length }, (_, i) => i) : Object.keys(from);
		for (const name of names) {
			const member = (from as { [key: string | number]: JsonValue | undefined })[name];
			const made = copyOne(member);
			if (Array.isArray(to)) to[name as number] = made;
			else Object.defineProperty(to, name, { value: made, enumerable: true, writable: true, configurable: true });
			if (made !== null && typeof made === "object") stack.push({ from: member as JsonValue[] | JsonObject, to: made });
		}
	}
	return root as T;
}

/** The first 128 code points of a string, and whether it was cut (EM9). */
export function cutTo128(text: string): { text: string; truncated: boolean } {
	const points = Array.from(text);
	return points.length > 128 ? { text: points.slice(0, 128).join(""), truncated: true } : { text, truncated: false };
}
