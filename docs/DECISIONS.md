# Decisions

One ruling per entry, append-only.\
A ruling is never edited; a later one supersedes it and says so.

Rulings that shape this component together with others are held in zorg's `docs/DECISIONS.md`, and cited here as "zorg's `Dn`".

---

## D1 - The component stands in its own repository

**Ruled by:** the director, 2026-10-09 (zorg's `D16`).\
**Affects:** this repository.

**Ruling.**\
This component was split out of zorg with the history of its vision and contract, and is private until its first working code.\
Its vision was ratified by zorg's `D5`, and its contract of record is `CONTRACT.md` (zorg's `D17`).

**Why.**\
Each component holds its own boundary and its own history from the start, as zorg's `D10` intends.

---

## D2 - Renamed entity-store

**Ruled by:** the director, 2026-10-09 (zorg's `D18`).\
**Affects:** this repository, its package, `VISION.md`, `CONTRACT.md` and `README.md`.

**Ruling.**\
The component formerly named entitystore is named entity-store, in hyphenated whole words like every other name in the workspace; its repository is `apnex/entity-store`, and GitHub redirects the old name.\
Earlier entries keep the name they were written with.

---

## D3 - The first release, 0.1.0, carrying the five shared fixes

**Ruled by:** the director, 2026-11-10 (draw's `H31-5`, on zorg's agreement: draw's request, `upstream/drawv2-shared-component-fixes-request.md`, and zorg's reply, `upstream/drawv2-shared-component-fixes-reply.md`, whose answers bind).\
**Affects:** `package.json` and its lockfile, `.nvmrc`, `.github/workflows/gate.yml` and `release.yml`, `tools/consumer-test.mjs`, `CONTRACT.md`'s frontmatter and Reference, and `README.md`; nothing in `src/`, and nothing the component does.

**Ruling.**\
The five fixes every consumer of the components zorg maintains needs, made by draw's builders on zorg's agreement, none changing what the component does:
1. A release in the pinned-file form, gated by CI: `gate.yml` runs `npm test` and `npm run docs:check` on every push and pull request on Node 22 and 24, then the consumer test on Node 22 -- the package packed, installed into an empty project with `--omit=dev`, no AGP package installed, and every export imported by name; `release.yml`, on a tag `v<version>` that the repository's `release tags` ruleset protects, runs the gate, packs the package once, attaches the `.tgz` and its `.sha512` to a draft GitHub release, downloads both back and compares them, and only then publishes, immutable releases being enabled for the repository before its first tag; the first release is `0.1.0`.
2. A Node 22 floor: `engines` `>=22`, and `.nvmrc` `22`.
3. Dependencies between components as release files: `@apnex/shape-check` from `file:../shape-check` to shape-check's `0.1.0` release file, each pinned in the lockfile by its integrity.
4. AGP declared as what it is: none: it takes nothing of AGP's.
5. The contract's frontmatter brought to mission-kit's: `id: C4`, `status: active`, and the sentences that said the id was unminted and the repository private until its first working code restated.

**Choices made at build.**
- `private: true` stays: it stops publishing to the npm registry, and `npm pack` packs the package with it.
- The style rules `npm run docs:check` holds are vendored in `tools/`, so CI fetches no mission-kit checkout.
- Its contract claims no browser runtime, so the consumer test imports the package in Node alone, loading nothing in Chrome.

**Why.**\
Draw takes components as public GitHub release files pinned by hash and runs Node 22 in production (draw's `H26-2`); a `file:` link builds only beside a checkout, and an AGP declared for install would make every consumer install it though every import of it is a type.

---

## D4 - A change of many writes, an expected position, and a note on a change

**Ruled by:** the director, 2026-11-11, drafted by drawv2 under its `H31-8` and co-signed by zorg (`zorg/docs/DECISIONS.md` `D76`).\
**Affects:** `CONTRACT.md` (*Designed, not yet built*, and a sentence in *Reference*); nothing in `src/`, `export-map.json` or the shared suite, and nothing the component does until it is built.

**Ruling.**\
Three extensions are designed, each extending a capability already in the contract:
1. **The many-item `change`**, serving the change of more than one write that `positioned-entity-write` promises (zorg's `D33`): 1 to 2,000 writes, no two to one entity, the resulting change record at most 8 MiB of canonical JSON, all or nothing at one position, repeat recognition over the whole change, and a third `WriteAnswer` variant, `{ position, writes }`.
2. **`expectedPosition`** on a change, refused as `position-moved` when the store's position is any other, decided after repeat recognition.
3. **An optional `note`** on a change: plain JSON read through `shape-check`'s `readPlainJson`, nesting at most 16 levels, at most 524,288 bytes (512 KiB) of canonical UTF-8 JSON; kept and digested when present, forgotten with its change, carried once per change in `changes` and `follow`; and absent from the record when not given, so every stored log and archive reads unchanged.

`entity-api` carries them under its own ruling, at the move that puts a consumer's storage on this component, or earlier.\
Until each is built and tested, the contract lists it under *Designed, not yet built*, and no export or suite case claims it.

**Why.**\
`drawv2` changes up to 2,000 entities in one request, all or nothing, as one version and one undo step, which `D33` shaped the change log for; `entity-graph` lands an edit whole through this operation, guards it by the position it was planned from, and keeps its undo record in the note, so it holds no record of its own.\
The limits are zorg's: 8 MiB leaves a page holding one change within the 16 MiB that `operation-call` carries, distinct targets keep each position's items unambiguous, and a note omitted when absent leaves every digest already written unchanged.\
The note's byte limit is settled from `drawv2`'s measurement of its undo records, given in the pull request that drafts this entry.

**Alternatives refuted.**\
New capability rows deferred under this ruling - the shared suite's own row lists (`src/contract-suite.ts`) would change with them, and this draft changes no source.\
A note on every write's item in `changes` - a change of 2,000 writes would repeat it 2,000 times in one page.

---

## D5 - The change of many writes, the expected position and the note built, in 0.2.0

**Ruled by:** the director, 2026-11-11 (draw's `H31-9`, on the contract `D4` designs and zorg co-signed under its `D76`; zorg's answers 1 and 2 to draw's `H31-3`, in `upstream/drawv2-planning-boundaries-reply.md`, bind the limits and the log's compatibility).\
**Affects:** `src/` (`change`, `checkRepeat("change", ...)`, the change log's third answer variant and optional `note`, the note on the first item in `changes` and `follow`), `CONTRACT.md` (the rows the extensions extend, the section that held them as designed, and *Reference*), `package.json` and its lockfile (`0.2.0`, and `0.1.0`'s release file as a development dependency), `README.md`, and new tests; nothing in `export-map.json` or the shared suite, and no existing test.

**Ruling.**\
The three extensions `D4` designs are built and released as `0.2.0`:
1. **`change(input, write)`**, the other writes' form, `input` being `{ writes, expectedPosition?, note? }` and each write `{ operation, input }`: 1 to 2,000 writes, no two to one entity, each judged as its single operation judges it against the state the writes before it leave, the record at most 8,388,608 bytes of canonical JSON, landing whole at one position or not at all, answered `{ position, writes }`.
2. **`expectedPosition`**, refused as `position-moved` naming the position expected and the store's, after repeat recognition.
3. **The note**, read through `readPlainJson`, at most 16 levels and 524,288 bytes of canonical UTF-8 JSON, kept in canonical form after the record's other fields and digested with the request, absent from the record when not given, carried once on the first of a change's items in `changes` and `follow`, forgotten with its change.

**Choices made at build.**
- New refusal codes in the shared form: `note-not-plain`, `empty-change`, `too-many-writes`, `note-too-deep`, `note-too-large`, `position-moved`, `duplicate-target` and `change-too-large`; a refusal of one write names its `index`, counting from 0, beside its single operation's details, and `duplicate-target` names the earlier write's index and the entity.
- `note-not-plain` is a refusal, not a thrown error, and comes before the write identity, since a note that is not plain JSON gives no request whose digest could be recognised.
- The single operations are unchanged, input, answer and record; a change of one write with an expected position or a note is made through `change`.
- Two writes target one entity when the identity a target names, resolved against the names the writes before it leave, is one an earlier write wrote; a delete followed by a create of the same name writes two entities, and is accepted.
- The shared suite carries no case of `change`, since `entity-api`, which runs it remotely, does not carry `change` (`D4`); the component's own tests hold the extensions, and `0.1.0`'s release file, pinned by the integrity its SHA-512 asset states, is a development dependency, so the tests compare the logs and archives the two write.

**Why.**\
The log compatibility zorg's answer 2 requires is shown, not asserted: the same writes through the single operations write a log and archive byte-identical to `0.1.0`'s, step by step across reopening, compaction and archiving; a log and archive `0.1.0` wrote open under `0.2.0` without a byte touched, every write it recorded recognised by its digest.\
A log holding a record `change` wrote is refused by `0.1.0` as `log-corrupt`, so a store goes back to `0.1.0` only from a log no `change` has written to.

**Alternatives refuted.**\
`change(writes, options)` with the writer and write identity in `options` - every other write takes `(input, write)`, and `entity-api` declares one input shape for each operation, its host naming the writer and the identity.\
The count of writes in the input shape, thrown when beyond it - every other limit a write meets is a refusal in the shared form, as `too-many-tags` and `writer-too-long` are.
