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
| `positioned-entity-write` | provides | `shape-check:plain-json-value` | Create, update and delete entities; each change - one or more writes, applied all or nothing - takes exactly one position. | T1 when storage is durable |
| `change-provenance` | provides | none | Each change records when it was made and the writer the application names, never checked for who it names and refused only when longer than 1024 Unicode code points (zorg's `D65`). | T1 when storage is durable |
| `expected-revision-write` | provides | none | A write may name the revision it expects, and is refused if another change got there first. | T1 when storage is durable |
| `repeat-recognition` | provides | `shape-check:plain-json-value` | A write carries an identity its writer supplies; a repeat under that identity takes no second position and returns the first answer, for as long as the change it repeats is within the history bound. | T1 when storage is durable |
| `identity-name-lookup` | provides | none | Read one entity by identity or by name, with the position the answer reflects. | none |
| `find-by-kind-tags` | provides | none | Find every entity matching a kind and any set of tags, with the position the answer reflects. | none |
| `changes-since-position` | provides | none | Every change after a position still held, once and in order, or a plain statement that the position is no longer held. | none |
| `follow-narrowed-set` | provides | none | Changes since a position, narrowed by kind and tags, reporting each entity as entering, changing within, or leaving the set; a reader may wait for the next change. | none |
| `stated-history-bound` | provides | none | History is kept to a bound the application states, any reader can read the bound, and a reader behind it is told so; once a change is outside the bound by the latest time in the change log, the store forgets its write identity, change record, time, items and superseded or deleted entity versions, keeping from the forgotten prefix only the latest envelope of each entity still alive at the forgotten frontier (zorg's `D68`, `D69`, `BL26`). | none |
| `storage-port` | provides | `shape-check:plain-json-value` | Persistence is through a storage port the application supplies, in memory or durable, with optional `compact(records)` replacing the active log with a leading `base` record (`position`, `at`, `digest`, `entities`) when changes have been forgotten (`forgottenThrough >= 1`), held `change` records and at most one trailing `time` record (or a single `time` record at `latestAt` with no `base` record on a time-only log at `position = 0`), and `createFileStoragePort(file, {archiveFile})` rotating evicted `change` records to an optional archive file before atomic replacement; what `load` returns, or throws, is read as plain data through `shape-check`'s `plain-json-value` (zorg's `D54`, `D55`), any non-plain return or throw refused as `log-corrupt` with any native promises met observed. | T1 when durable |
| `store-refusal` | provides | none | A refusal of a write or read says, in the shared refusal form, what was wrong and how to fix it: a body that does not fit its kind, a revision that moved, a position no longer held. | none |

**Traits.**\
A system that contains entity-store and writes to durable storage owns persistent state something else relies on, so it is stateful (`T1`) and `A1` binds it.\
Used only in memory, as a cache that can be dropped without changing any decision, it brings no trait.\
When independent actors write the same store, the system holding it is also multi-agent (`T3`); that follows from how the store is shared, not from any one capability.

---

## Reference

This repository, `apnex/entity-store`, and its package `@apnex/entity-store`, released only by its own CI as a tarball attached to a GitHub release, drafted, verified and then published (`.github/workflows/release.yml`).\
The package `@apnex/entity-store` exports `openEntityStore` and `createMemoryStoragePort` (implementing `compact(records)` alongside `load` and `append`), `@apnex/entity-store/file-storage` exports `createFileStoragePort` (accepting `options?: {archiveFile?: string}`, rotating evicted `change` records to `archiveFile` when given, validating `archiveFile` from its `64`-byte header and a backwards-doubling tail read starting at `64` KiB against `base`'s `position`, `at` and `digest`, and replacing `file` atomically via `${file}.compact`) and `LOG_HEADER`, and `@apnex/entity-store/contract-suite` exports `registerEntityStoreSuite` and `contractSuiteRows`, the shared contract suite, as `export-map.json` records.\
`changes-since-position` is served through `openEntityStore` as `changes`, and `follow-narrowed-set` as `follow` and `waitForChange`, each carried by the shared contract suite, built in zorg's Delta 4 under `D64` (zorg's target, `EM16` and `EM17`); the suite's cases of `follow` judge the items and `through` across pages and keep within the input shape entity-api serves `follow` under, so entity-api runs them remotely, and the exact pages, inputs beyond that shape, programming errors and `waitForChange` are this component's own tests.\
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
