---
id: C4
category: component
title: entity-store - typed, tagged entities in one order of changes
status: active
hydrate-when: Several parties share small typed records, and each must know how current its view is and what changed since it last looked
sovereignty: internal
supersedes: []
related: [C0, A1, A3, T1]
---

# entity-store

The contract of record for entity-store: what a consumer can depend on, written before any consumer's architecture so that it states the whole offer.\
It also carries the fields of a mission-kit registry entry, and that entry is generated from this file, never written as a second copy.\
Admitted to mission-kit's component registry as `C4`, its first release `0.1.0` (`docs/DECISIONS.md` `D3`); its frontmatter is the entry's.

---

## Duty

Keep typed, tagged entities in a single order of changes that every read can be dated against.

---

## Contract

What a consumer can depend on, one capability per row.\
A capability is named for what it offers, not for who offers it, so two components that provide the same capability share its name, and the overlap is visible.\
**Provides** means this component implements the capability; **carries from X** means it passes X's capability through its own interface.\
**Requires** names the capabilities of other components a row depends on, as `component:capability`, so a census can follow an application's demand down through the components it reaches.\
The trait column names any trait a system takes on by using the capability.

| Capability | Relation | Requires | What a consumer can depend on | Trait |
|---|---|---|---|---|
| `declared-shape-validation` | carries from shape-check | none | Kinds are supplied by the application as declared shapes; a write that does not fit its kind is refused, and no kind is built in. | none |
| `positioned-entity-write` | provides | `shape-check:plain-json-value` | Create, update and delete entities; each change - one or more writes, applied all or nothing - takes exactly one position; `change` makes a change of 1 to 2,000 writes, no two to one entity, its record at most 8,388,608 bytes of canonical JSON (`D4`, `D5`). | T1 when storage is durable |
| `change-provenance` | provides | none | Each change records when it was made and the writer the application names, never checked for who it names and refused only when longer than 1024 Unicode code points (zorg's `D65`); a change may carry a note, plain JSON the store never interprets, kept and digested with its change and carried once, on the first of its items, in `changes` and `follow` (`D4`, `D5`). | T1 when storage is durable |
| `expected-revision-write` | provides | none | A write may name the revision it expects, and is refused if another change got there first; a change may name the store position it expects, and is refused if any change landed since (`D4`, `D5`). | T1 when storage is durable |
| `repeat-recognition` | provides | `shape-check:plain-json-value` | A write carries an identity its writer supplies; a repeat under that identity takes no second position and returns the first answer, for as long as the change it repeats is within the history bound; a change of many writes is one request, its note included (`D4`, `D5`). | T1 when storage is durable |
| `identity-name-lookup` | provides | none | Read one entity by identity or by name, with the position the answer reflects. | none |
| `find-by-kind-tags` | provides | none | Find every entity matching a kind and any set of tags, with the position the answer reflects. | none |
| `changes-since-position` | provides | none | Every change after a position still held, once and in order, or a plain statement that the position is no longer held. | none |
| `follow-narrowed-set` | provides | none | Changes since a position, narrowed by kind and tags, reporting each entity as entering, changing within, or leaving the set; a reader may wait for the next change. | none |
| `stated-history-bound` | provides | none | History is kept to a bound the application states, any reader can read the bound, and a reader behind it is told so; once a change is outside the bound by the latest time in the change log, the store forgets its write identity, change record, time, items and superseded or deleted entity versions, keeping from the forgotten prefix only the latest envelope of each entity still alive at the forgotten frontier (zorg's `D68`, `D69`, `BL26`). | none |
| `storage-port` | provides | `shape-check:plain-json-value` | Persistence is through a storage port the application supplies, in memory or durable, with optional `compact(records)` replacing the active log with a leading `base` record (`position`, `at`, `digest`, `entities`) when changes have been forgotten (`forgottenThrough >= 1`), held `change` records and at most one trailing `time` record (or a single `time` record at `latestAt` with no `base` record on a time-only log at `position = 0`), and `createFileStoragePort(file, {archiveFile})` rotating evicted `change` records to an optional archive file before atomic replacement; what `load` returns, or throws, is read as plain data through `shape-check`'s `plain-json-value` (zorg's `D54`, `D55`), any non-plain return or throw refused as `log-corrupt` with any native promises met observed; a change record holds a `note` only when its change has one, so a log or archive written before the note reads unchanged (`D4`, `D5`). | T1 when durable |
| `store-refusal` | provides | none | A refusal of a write or read says, in the shared refusal form, what was wrong and how to fix it: a body that does not fit its kind, a revision that moved, a position no longer held, a store position that moved, a change beyond its bounds, naming the write that led there. | none |

**Traits.**\
A system that contains entity-store and writes to durable storage owns persistent state something else relies on, so it is stateful (`T1`) and `A1` binds it.\
Used only in memory, as a cache that can be dropped without changing any decision, it brings no trait.\
When independent actors write the same store, the system holding it is also multi-agent (`T3`); that follows from how the store is shared, not from any one capability.

---

## The change of many writes, the expected position and the note

Three extensions of the capabilities above, designed under `D4` and built in `0.2.0` under `D5`.\
Each extends a row already in the table rather than adding one, so the rows and `export-map.json` name the same capabilities as before, and each row now states what it serves.

**The many-item `change` (extends `positioned-entity-write`, `repeat-recognition` and `store-refusal`).**\
`positioned-entity-write` already promises a change of one or more writes taking one position (zorg's `D33`); `change` is the operation that serves a change of more than one.\
It is called as `change(input, write)`, the other writes' form: `input` is `{ writes, expectedPosition?, note? }`, and `write` the `{ writer, writeId }` every write takes, one for the whole change.\
It takes 1 to 2,000 writes, each `{ operation, input }`, a create, an update or a delete with the input the single operation takes.\
No two writes may target one entity, by identity or by kind and name, names judged as the change would leave them.\
Each write is judged as its single operation judges it - its kind's shape, its name, its expected revision - against the state the writes before it in the change leave; one refusal refuses the whole change, naming in its details the `index` of the write that led there, counting from 0 as the list of writes does, and nothing is applied.\
The resulting change record is at most 8,388,608 bytes (8 MiB) of canonical JSON, so a page of `changes` or `follow` holding it stays within what a carrier of 16 MiB admits.\
The change takes exactly one position; an entity it creates takes the identity `e<position>.<place>`, `place` its write's place in the change, counting from 1; each entity's revision moves as a single write would move it.\
Repeat recognition covers the whole change: the digest is of the whole request, and a repeat answers with the first answer; `checkRepeat("change", input, write)` asks it without making the change.\
Its answer is a third `WriteAnswer` variant, `{ position, writes }`, `writes` holding, in the order the writes were given, `{ entity }` for a create or an update and `{ deleted }` for a delete, each as the single operation would answer it.\
`changes` and `follow` give one item for each write of the change, as they do today.\
A page of `changes` or `follow` holding a change can be far larger than its record, because each delete's item repeats the change's writer, which the record holds once: the page's bound is the writer's length times 2,000, not the record's 8 MiB.\
Measured at build, 2,000 deletes under a writer of 1,024 control characters, each written as six bytes, make a record of 249,033 bytes and a page of 12,541,824; the independent check of this build put the worst case at about 16.55 MB, within the 16 MiB a carrier admits by about 1.4%.

**The expected position (extends `expected-revision-write` and `store-refusal`).**\
A change, of one write or many, may name `expectedPosition`, the store position its writer last saw.\
It is refused as `position-moved`, naming the position expected and the store's, when the store's position is any other.\
Repeat recognition is decided first, so a repeat of a change that landed answers with its first answer however far the store has moved since.

**The note on a change (extends `change-provenance` and `storage-port`).**\
A change, of one write or many, may carry a `note`: a value the application names and the store never interprets.\
It is read as plain JSON through `shape-check`'s `readPlainJson`, nests at most 16 levels, and is at most 524,288 bytes (512 KiB) of canonical UTF-8 JSON; a note beyond either bound is refused, and the whole change with it.\
A note holding an integer more than 9007199254740991 from zero is refused as `note-unsafe-number`, naming where, as an entity's body is refused as `unsafe-number`, since AGP could not carry the items of `changes` and `follow` holding it.\
A note that is not plain JSON is refused as `note-not-plain`, before the write identity is checked, since it gives no request to recognise; a note given as `undefined` is no note.\
When present, the note is kept in the change record in canonical form, after the record's other fields, included in the change's digest, and forgotten with the change when the history bound passes it; an archive the application configures keeps the evicted record whole.\
When absent, the change record has no `note` field, so every log and archive written before the note existed reads unchanged, with the same fields and the same digests.\
`changes` and `follow` carry a change's note once, on the first of that change's items in each answer, never repeated on each write's item.

**The order of a change's refusals.**\
`note-not-plain`; then `identity-reused` and `writer-too-long`, as for every write; then `empty-change`, `too-many-writes`, `note-too-deep`, `note-too-large`, `note-unsafe-number` and `position-moved`; then each write in order, with the refusals its single operation gives in their order and `duplicate-target` after `empty-update`; and last `change-too-large`, on the record the change would append.\
A change's input that does not fit its shape, or a write's input that does not fit its operation's, is a programming error, thrown as a `TypeError` naming the field, as for every operation.

**Carried by `entity-api`.**\
`entity-api` (`C6`) carries `change` and `expectedPosition` to its clients when it adds them, under its own ruling; until then they are served only to an application embedding the store.\
A note reaches remote readers sooner: `entity-api` serves `changes` and `follow`, whose items carry it, so once it runs this component's `0.2.0` every remote reader is given the notes an embedding application wrote, which is why a note holds nothing AGP cannot carry.\
The shared contract suite, which `entity-api` runs remotely, holds no case of `change`; the three extensions are this component's own tests.\
A log holding a record that `change` wrote, with a note or without, is not readable by `0.1.0`, which refuses it as `log-corrupt`.

---

## Reference

This repository, `apnex/entity-store`, and its package `@apnex/entity-store`, released only by its own CI as a tarball attached to a GitHub release, drafted, verified and then published (`.github/workflows/release.yml`).\
The package `@apnex/entity-store` exports `openEntityStore` and `createMemoryStoragePort` (implementing `compact(records)` alongside `load` and `append`), `@apnex/entity-store/file-storage` exports `createFileStoragePort` (accepting `options?: {archiveFile?: string}`, rotating evicted `change` records to `archiveFile` when given, validating `archiveFile` from its `64`-byte header and a backwards-doubling tail read starting at `64` KiB against `base`'s `position`, `at` and `digest`, and replacing `file` atomically via `${file}.compact`) and `LOG_HEADER`, and `@apnex/entity-store/contract-suite` exports `registerEntityStoreSuite` and `contractSuiteRows`, the shared contract suite, as `export-map.json` records.\
`changes-since-position` is served through `openEntityStore` as `changes`, and `follow-narrowed-set` as `follow` and `waitForChange`, each carried by the shared contract suite, built in zorg's Delta 4 under `D64` (zorg's target, `EM16` and `EM17`); the suite's cases of `follow` judge the items and `through` across pages and keep within the input shape entity-api serves `follow` under, so entity-api runs them remotely, and the exact pages, inputs beyond that shape, programming errors and `waitForChange` are this component's own tests.\
The many-item `change`, the expected position and the note on a change are served through `openEntityStore` as `change` and its input's `expectedPosition` and `note`, built under `D5` and tested by this component's own tests, not by the shared suite while `entity-api` does not carry them.\
It depends on `@apnex/shape-check` through a `file:` link, and only its file storage port, `src/file-storage-adapter.ts`, imports a module particular to one runtime.

---

## Fit criteria

### Does my project want this at all

- Several parties write and read small structured records, and someone will ask "what changed since I last looked?"
- An agent acts on what it reads, and must know how current that is.
- A write may be repeated after a lost answer, and must not land twice.

### Does it meet my requirement

- Lookup is by identity, name, kind and tags.
- Every change has one place in one order, and every read reports its position.
- Following a narrowed set reports entities leaving it, not only entering and changing.

**It is the wrong tool when**

| You need | Reach elsewhere, because entity-store is |
|---|---|
| access from another process or machine | not a network service; see entity-api |
| changes pushed to parties that did not ask | not a notifier |
| a record of who reads and how far they got | not a keeper of readers |
| relationships, joins or traversal | not a graph |
| free-text search or ranking | not a search engine |
| large content | not a document store |
| history kept beyond catch-up, for audit | not an archive |
| a decision about who may write | not an authority |

---

## Adjustment policy

Internal and sovereign, so a fit gap has somewhere to go.

1. Record a measured gap where both sides can see it.
2. Resolve it by adjusting entity-store, so every consumer gets the change, or by fracturing it when the gap reveals a second duty.
3. Never fork.

Kinds and storage are supplied through declared seams, so a new kind or a new storage medium needs no change to entity-store.

---

## Edges

**Composes:** nothing registered.

**Consumes, through a declared contract:**

- `shape-check`: `declared-shape-validation`, `plain-json-value`

It never reaches the network.

**Composed-by:** nothing yet.\
Its first consumer, once built, is entity-api's host half.

The registry's edge vocabulary has no edge for one component using another's contract without containing it; see the note in operation-call's entry.
