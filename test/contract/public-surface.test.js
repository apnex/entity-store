// public-surface - the package exposes exactly what export-map.json names (zorg's target, EM14; E12).
//
// Every path in package.json's exports is named in the map; each module path is imported by its public name
// and its runtime exports compared with the map; every capability row of CONTRACT.md is served by some export
// or deferred with a ruling. The source imports no module particular to one runtime outside a file whose name
// ends -adapter.ts (D31, principle 6), and never reads the wall clock: time comes from the clock port.
import assert from "node:assert/strict";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(root, "export-map.json"), "utf8"));
const publicName = (p) => p === "." ? pkg.name : `${pkg.name}/${p.slice(2)}`;

test("the export map names the package and exactly its exported paths", () => {
	assert.equal(map.package, pkg.name);
	assert.deepEqual(Object.keys(map.paths).sort(), Object.keys(pkg.exports).sort());
});

for (const [p, entry] of Object.entries(map.paths)) {
	test(`${publicName(p)} exposes what the map names`, async () => {
		assert.ok(entry.exports, `${p} names no exports`);
		const mod = await import(publicName(p));
		assert.deepEqual(Object.keys(mod).sort(), Object.keys(entry.exports).sort());
		for (const [name, use] of Object.entries(entry.exports)) {
			assert.equal(use.part, "entity-store", `${name} realises the entity-store part`);
			assert.ok(Array.isArray(use.serves) && use.serves.length > 0, `${name} serves at least one row`);
		}
	});
}

const contractRows = () => {
	const lines = fs.readFileSync(path.join(root, "CONTRACT.md"), "utf8").split("\n");
	const start = lines.findIndex((l) => /^\|\s*Capability\s*\|\s*Relation\s*\|/.test(l));
	const rows = [];
	for (let i = start + 2; start >= 0 && lines[i]?.startsWith("|"); i++) rows.push(lines[i].split("|")[1].trim().replaceAll("`", ""));
	return rows;
};

test("every contract row is served by an export or deferred with a ruling, never both, and every row served is a contract row", () => {
	const rows = contractRows();
	const served = new Set(Object.values(map.paths).flatMap((e) => Object.values(e.exports)).flatMap((x) => x.serves));
	for (const row of rows) assert.ok(served.has(row) || map.deferred[row], `${row} is neither served nor deferred`);
	for (const row of served) assert.ok(rows.includes(row), `${row} is not a row of CONTRACT.md`);
	for (const [row, ruling] of Object.entries(map.deferred)) {
		assert.match(ruling, /^D\d+$/, `${row} is deferred without a ruling`);
		assert.ok(!served.has(row), `${row} is both served and deferred`);
		assert.ok(rows.includes(row), `${row} is not a row of CONTRACT.md`);
	}
});

test("the shared suite lists the rows it covers, the local-only rows and the deferred ones as the map does", async () => {
	const { contractSuiteRows } = await import(`${pkg.name}/contract-suite`);
	assert.deepEqual([...contractSuiteRows.carried].sort(), [...map.paths["./contract-suite"].exports.registerEntityStoreSuite.serves].sort());
	assert.deepEqual({ ...contractSuiteRows.deferred }, map.deferred);
	const all = [...contractSuiteRows.carried, ...contractSuiteRows.localOnly, ...Object.keys(contractSuiteRows.deferred)].sort();
	assert.deepEqual(all, contractRows().sort(), "every row is carried by the suite, local only, or deferred");
});

const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? sources(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const specifiers = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
// Source with its comments removed, so prose about a process or a clock is not mistaken for code.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

test("no source file imports a module particular to one runtime outside a file whose name ends -adapter.ts", () => {
	const files = sources(path.join(root, "src")).filter((f) => f.endsWith(".ts"));
	assert.ok(files.some((f) => f.endsWith("-adapter.ts")), "the file storage port is an adapter");
	for (const file of files) {
		const name = path.relative(root, file);
		const text = fs.readFileSync(file, "utf8");
		const runtime = specifiers(text).filter((s) => s.startsWith("node:") || builtins.has(s));
		if (file.endsWith("-adapter.ts")) continue;
		assert.deepEqual(runtime, [], `${name} imports ${runtime.join(", ")}`);
		assert.doesNotMatch(code(text), /\b(process|Buffer|__dirname|__filename)\b|\brequire\s*\(/, `${name} uses a global particular to Node`);
	}
});

test("no source file reads the wall clock: time comes only from the clock port the application supplies", () => {
	for (const file of sources(path.join(root, "src")).filter((f) => f.endsWith(".ts"))) {
		const text = fs.readFileSync(file, "utf8");
		assert.doesNotMatch(code(text), /Date\.now\s*\(|new Date\s*\(\s*\)|performance\.now|Temporal\.Now/, `${path.relative(root, file)} reads the wall clock`);
	}
});

const validDepSpec = (name, spec) => spec === `file:../${name}` || new RegExp(`^https://github\\.com/apnex/${name}/releases/download/v0\\.\\d+\\.\\d+/apnex-${name}-0\\.\\d+\\.\\d+\\.tgz$`).test(spec);

test("the package depends on shape-check through a file: link or pinned GitHub release URL, and nothing else at run time", () => {
	assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ["@apnex/shape-check"]);
	assert.ok(validDepSpec("shape-check", pkg.dependencies["@apnex/shape-check"]));
});
