// independent-canonical - canonical JSON (shape-check's SD4), its UTF-8 size and the digest of a change,
// written here independently of the store's own, so a test measures what the store wrote rather than
// asking the store to measure itself.
import crypto from "node:crypto";

const byCodePoint = (a, b) => {
	const x = Array.from(a, (c) => c.codePointAt(0));
	const y = Array.from(b, (c) => c.codePointAt(0));
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
	return x.length - y.length;
};

/** Canonical JSON: object members sorted by code point, no whitespace. */
export const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
	: v !== null && typeof v === "object" ? `{${Object.keys(v).sort(byCodePoint).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
	: JSON.stringify(v);

/** The size in UTF-8 bytes of a value's canonical JSON. */
export const canonicalBytes = (v) => Buffer.byteLength(canonical(v), "utf8");

/** EM7's digest: SHA-256 over the canonical JSON of the input as received, the operation and the writer. */
export const writeDigest = (operation, input, writer) => crypto.createHash("sha256").update(Buffer.from(canonical({ input, operation, writer }), "utf8")).digest("hex");

/** The digest of a change (D4): of the whole request, under the operation name change. */
export const changeDigest = (input, writer) => writeDigest("change", input, writer);
