# AGENTS.md

## Project overview

`pi-slopchop-jj` is a Pi coding-agent extension that adds the `/diff` terminal review UI. It lets users review diffs, annotate lines/files/whole changes, and insert a follow-up prompt back into Pi.

The package is loaded by Pi from `./src/index.ts`.

This is my Jujutsu-only fork of `pi-slopchop`; it does not support Git repositories.

## Local installation

After every change, run `pi install .` from the repository root so Pi uses the local package.
