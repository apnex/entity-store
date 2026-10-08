# entitystore - Vision

**Status: draft, enduring once ratified.**\
This document states why entitystore exists and what it will never be.\
It carries no current state, no roadmap, and no schedule.

Holding this document authorises nothing.\
It does not ratify a decision, admit a component to any registry, or approve a contract change.\
A change of direction is recorded as a decision first and absorbed here afterwards.

---

## North star

> Keep a shared set of typed, tagged entities that readers find by identity, name, kind, or tag, in which every change has one place in one order, so any reader knows exactly how current its view is and what changed since.

Five terms in that sentence carry weight, so this document defines them rather than leaving them to the reader.

**Entity** means a small, structured record with an identity, a name, a kind, tags, and a body whose shape its kind declares.

**Find** means a reader asks by identity, by name, or by kind and any set of tags, and gets every entity that matches, with the position the answer reflects.

**One place in one order** means the store keeps a single order of changes.\
Each change takes exactly one position, a write repeated under the same identity included, and positions never move or repeat.

**How current its view is** means every read reports the position it reflects.

**What changed since** means every later change from any position still held, once and in order, or a plain statement that the position is no longer held.

---

## Why it exists

Agents and applications need a shared record of small facts that many parties write and read.\
The record is easy.\
What gets built late, and expensively, is the answer to "what changed since I last looked?", and by then the data has no order to answer it from.

An agent acting on a view it cannot date is acting on a guess.\
One that repeats a write after a lost answer needs the store to recognise the repeat, not apply it twice.

entitystore puts order, currency, and repeat recognition in from the first write.

---

## What it is

An embeddable library that keeps entities of the kinds an application gives it.\
It refuses any write that does not fit its kind, or that would overwrite a change its author never saw.\
It answers reads by identity, by name, by kind and tags, and since a position.

It is embedded by an application that owns its own process, configuration, and storage.

---

## What it is not

**Not a network service.**\
It never listens and never sends.\
Reaching it from elsewhere is someone else's job.

**Not a notifier.**\
It never pushes to anyone.\
It hands changes to readers that ask, including a reader that waits for the next one.

**Not a keeper of readers.**\
It holds no record of who reads or how far they have got.\
Each reader keeps its own position.

**Not a graph.**\
There are no relationships between entities, no joins, and no traversal.\
Lookup is by identity, name, kind, and tags.

**Not a search engine.**\
There is no free-text search and no ranking.

**Not a document store.**\
Entities are small.\
Content too large to be a record lives elsewhere and is referenced.

**Not an archive.**\
History is kept so readers can catch up, to a stated bound.\
A reader behind that bound is told so, never handed a partial history.

**Not the owner of meaning.**\
It knows the shape each kind declares, never what a kind means.\
No kind is built in.

**Not an authority.**\
It does not decide who may write; the application decides before it calls.

---

## What success means

Four dimensions.\
They are not weighted, and they do not collapse.

**Exactness.**\
No change is lost, reordered, or applied twice, across restarts and repeated writes.\
The measure is that a reader following from any held position sees every later change exactly once, in order, and its view matches the store's at that position.

**Leanness.**\
It is small to embed, small to read, and cheap per write.\
The measure is per-write cost and code size, stated and small.

**Legibility.**\
A refusal says what was wrong and how to fix it: a body that does not fit its kind, a revision that moved, a position no longer held.\
The measure is that every refusal carries enough to act on.

**Reuse.**\
A second, unrelated application with kinds of its own adopts it without a variant, a fork, or a change to the store.

A programme strong on three of these and weak on one has one unmet dimension, and which one it is says more than any average of the four.

---

## Authority

Held by the director.\
Drafted by anyone; ratified only by the director.

This statement is amended, never quietly rewritten.\
A ruling that changes direction is recorded as a decision and absorbed here, so the reasoning survives the change.

Where this narrative and a verified record disagree about state, the record governs.
