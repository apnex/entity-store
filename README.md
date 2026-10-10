# entity-store

Keep typed, tagged entities in a single order of changes that every read can be dated against.

**Status: built, and certified at zorg's Delta 1, stage 2, at `49ba930`.**\
Its contract tests run its shared contract suite against a store in this process, over memory and over a change log file, and recover a store from a process killed with `SIGKILL`.

- `VISION.md` - why it exists, and what it will never be.
- `CONTRACT.md` - what a consumer can depend on, one capability per row.
- `docs/DECISIONS.md` - the rulings about this component.

It belongs to a component set first composed by zorg (`apnex/zorg`), and is private until its first working code.

It depends on `@apnex/shape-check` through a `file:` link to a checkout beside it, which must be built first, since shape-check's `dist/` is not committed.

To run the tests from clean checkouts:
```sh
(cd ../shape-check && npm install && npm run build)
npm install
npm test
```
