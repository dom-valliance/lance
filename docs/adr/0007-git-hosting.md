# 0007. Git hosting on GitHub

Date: 2026-09-19
Status: Accepted

## Context

The workspace had no repository. Spec section 3.2 names GitHub Actions for CI. Dom creates the remote.

## Decision

`git init` on `main`. Dom creates the GitHub repository, adds the remote and handles everything GitHub-side (PR creation, reviews, merges). Claude uses plain git only: branches named `type/short-description`, conventional commits, no `gh` CLI. Dom declined the `gh` install on 2026-09-19.

## Consequences

CI runs on first push. Until then work is committed locally on feature branches and verified with the same commands CI runs. Claude's handover for each piece of work is a branch name and a commit range, not a PR.
