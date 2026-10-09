---
id: unminted
category: component
title: entitystore - typed, tagged entities in one order of changes
status: draft
hydrate-when: Several parties share small typed records, and each must know how current its view is and what changed since it last looked
sovereignty: internal
supersedes: []
related: [C0, A1, A3, T1]
---

# entitystore

Draft registry entry, written before any consumer's architecture so that its contract states the whole offer.\
The id is unminted on purpose; one is minted only when the entry is admitted to the registry.

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
| `declared-shape-validation` | carries from shapecheck | none | Kinds are supplied by the application as declared shapes; a write that does not fit its kind is refused, and no kind is built in. | none |
| `positioned-entity-write` | provides | none | Create, update and delete an entity; each change takes exactly one position. | T1 when storage is durable |
| `change-provenance` | provides | none | Each change records when it was made and the writer the application names, unchecked. | T1 when storage is durable |
| `expected-revision-write` | provides | none | A write may name the revision it expects, and is refused if another change got there first. | T1 when storage is durable |
| `repeat-recognition` | provides | none | A write carries an identity its writer supplies; a repeat under that identity takes no second position and returns the first answer, for as long as the change it repeats is within the history bound. | T1 when storage is durable |
| `identity-name-lookup` | provides | none | Read one entity by identity or by name, with the position the answer reflects. | none |
| `find-by-kind-tags` | provides | none | Find every entity matching a kind and any set of tags, with the position the answer reflects. | none |
| `changes-since-position` | provides | none | Every change after a position still held, once and in order, or a plain statement that the position is no longer held. | none |
| `follow-narrowed-set` | provides | none | Changes since a position, narrowed by kind and tags, reporting each entity as entering, changing within, or leaving the set; a reader may wait for the next change. | none |
| `stated-history-bound` | provides | none | History is kept to a bound the application states, any reader can read the bound, and a reader behind it is told so. | none |
| `storage-port` | provides | none | Persistence is through a storage port the application supplies, in memory or durable. | T1 when durable |
| `store-refusal` | provides | none | A refusal of a write or read says, in the shared refusal form, what was wrong and how to fix it: a body that does not fit its kind, a revision that moved, a position no longer held. | none |

**Traits.**\
A system that contains entitystore and writes to durable storage owns persistent state something else relies on, so it is stateful (`T1`) and `A1` binds it.\
Used only in memory, as a cache that can be dropped without changing any decision, it brings no trait.\
When independent actors write the same store, the system holding it is also multi-agent (`T3`); that follows from how the store is shared, not from any one capability.

---

## Reference

Not yet built.\
This repository, `apnex/entitystore`, private until its first working code: `VISION.md` and, once built, the implementation.

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

| You need | Reach elsewhere, because entitystore is |
|---|---|
| access from another process or machine | not a network service; see entityapi |
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
2. Resolve it by adjusting entitystore, so every consumer gets the change, or by fracturing it when the gap reveals a second duty.
3. Never fork.

Kinds and storage are supplied through declared seams, so a new kind or a new storage medium needs no change to entitystore.

---

## Edges

**Composes:** nothing registered.

**Consumes, through a declared contract:**

- `shapecheck`: `declared-shape-validation`

It never reaches the network.

**Composed-by:** nothing yet.\
entityapi's host half consumes it once built.

The registry's edge vocabulary has no edge for one component using another's contract without containing it; see the note in opcall's entry.
