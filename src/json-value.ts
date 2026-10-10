/**
 * JSON values as the store holds them, and the measures the target applies to them: canonical JSON and its
 * size in UTF-8 bytes (shape-check's SD4), nesting depth (EM10), and the first integer AGP cannot carry, in
 * SD5's pointer order (EM9).
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
export function isJson(value: unknown, depth = 0): value is JsonValue {
	if (depth > 10000) return false;
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return false;
		return Object.values(value).every((item) => isJson(item, depth + 1));
	}
	return false;
}

/** Canonical JSON (SD4): no whitespace, properties by code point, strings and numbers as JSON.stringify writes them. */
export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const names = Object.keys(value).sort(compareCodePoints);
		return `{${names.map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name] as JsonValue)}`).join(",")}}`;
	}
	return JSON.stringify(value);
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
	if (value === null || typeof value !== "object") return 0;
	let deepest = 0;
	for (const member of Object.values(value)) deepest = Math.max(deepest, nestingDepth(member));
	return 1 + deepest;
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
	if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) > SAFE_INTEGER_LIMIT ? at : undefined;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const found = firstUnsafeInteger(value[i] as JsonValue, `${at}/${i}`);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (value !== null && typeof value === "object") {
		for (const name of Object.keys(value).sort(compareCodePoints)) {
			const found = firstUnsafeInteger(value[name] as JsonValue, `${at}/${pointerToken(name)}`);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

/** A deep copy of a JSON value, so nothing a caller holds can change what the store holds. */
export function copyJson<T extends JsonValue>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** The first 128 code points of a string, and whether it was cut (EM9). */
export function cutTo128(text: string): { text: string; truncated: boolean } {
	const points = Array.from(text);
	return points.length > 128 ? { text: points.slice(0, 128).join(""), truncated: true } : { text, truncated: false };
}
