# AGENTS.md

## Project overview

`pi-slopchop` is a Pi coding-agent extension that adds the `/diff` terminal review UI. It lets users review diffs, annotate lines/files/whole changes, and insert a follow-up prompt back into Pi.

The package is loaded by Pi from `./src/index.ts`.

This is my private fork that uses Jujutsu instead of Git (this is not the public pi-slopchop).

## Local installation

After every change, run `pi install .` from the repository root so Pi uses the local package.
