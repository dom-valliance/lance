# Fixtures

Per ADR 0006, this directory holds synthetic connector recordings committed to the main
repository, ahead of the private submodule planned for Phase 2.

- `fixtures/connectors/<name>/` holds synthetic recordings for each connector. Nothing personal
  is committed here.
- `fixtures/evals/` is gitignored. It becomes the mount point for the private, anonymised eval
  set submodule when Phase 2 needs it. It does not exist until then.
