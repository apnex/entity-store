# entity-store

Keep typed, tagged entities in a single order of changes that every read can be dated against.

**Status: built, and certified at zorg's Delta 1, stage 2 (`49ba930`), Delta 2, stage 1 (`5a6b6d9`), Delta 4, stage 1 (`49770a5`), and Delta 4, stage 5 (`8556911`).**\
Its contract tests run its shared contract suite against a store in this process, over memory and over a change log file, and recover a store from a process killed with `SIGKILL`.

- `VISION.md` - why it exists, and what it will never be.
- `CONTRACT.md` - what a consumer can depend on, one capability per row.
- `docs/DECISIONS.md` - the rulings about this component.

It belongs to a component set first composed by zorg (`apnex/zorg`), and is released only by its own CI, as a tarball attached to a GitHub release with its SHA-512 beside it, which a consumer names in its `package.json`: `https://github.com/apnex/entity-store/releases/download/v0.2.0/apnex-entity-store-0.2.0.tgz` for `0.2.0`, which adds the change of many writes, the expected position and the note on a change (`docs/DECISIONS.md` `D5`).

It depends on `@apnex/shape-check` through a `file:` link to a checkout beside it, which must be built first, since shape-check's `dist/` is not committed.

To run the tests from clean checkouts:
```sh
(cd ../shape-check && npm install && npm run build)
npm install
npm test
```
