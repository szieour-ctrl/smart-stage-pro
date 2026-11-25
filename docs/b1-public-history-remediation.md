# Removing B1 private material from the public branch history (PROPOSED; not performed)

`smart-stage-pro` is public. Six commits on the development branch carried private B1 material: the full B1 v1.2.1 instructions and frozen
article text (`tests/fixtures/b1-evidence/`), and article-derived strings in tests and docs. The tip commit that follows removes all of it (the
fixtures now live in the private B1 workspace, `ssp_fixtures/`). Earlier commits still hold it, and so do two public branches.

## What is exposed (inspected Nov 5, 2026)

| Ref | Commits with private material | On `main`? |
|---|---|---|
| `claude/optimistic-allen-k7rcoj` (PR #218, draft) | `4126e20`, `a078a11`, `e2a5dc4`, `c8b3ee3`, `bdcedca`, `83fb916` | no |
| `claude/laughing-edison-adense` (no PR) | `4126e20`, `a078a11`, `e2a5dc4` | no |
| `refs/pull/218/head` (GitHub) | the PR head and every head it has had | no |

Production `main` (`622f96e`) has never contained these paths. Nothing below touches `main`.

## Procedure (needs separate approval: it force-pushes and deletes a branch)

1. **Freeze.** Keep PR #218 in draft; nobody pushes to either branch.
2. **Build a clean branch locally** from `origin/main` with ONE commit whose tree equals the remediated tip (no intermediate commit, so no
   history carries the files):
   `git checkout -b b1-stageb-clean origin/main && git checkout <remediated tip> -- . && git commit` (with `git rm` of paths no longer present).
3. **Verify before pushing:** the tree equals the remediated tip (`git diff <tip> b1-stageb-clean` is empty); no reachable object outside `main`
   contains the B1 prompt or any string from the private `cases.json` (`git rev-list --objects origin/main..b1-stageb-clean` + `git cat-file`
   grep); the full suite passes with and without `B1_WORKSPACE`.
4. **Replace the public refs:**
   - `git push --force-with-lease=claude/optimistic-allen-k7rcoj:<current sha> origin b1-stageb-clean:claude/optimistic-allen-k7rcoj`
   - `git push origin --delete claude/laughing-edison-adense` (it has no PR; its commits are all on the branch above).
5. **PR #218:** the force-push updates its head, but the PR timeline keeps links to the old commits, and GitHub keeps them reachable by SHA.
   Close #218 and open a fresh draft PR from the clean branch.
6. **GitHub Support** (only they can do this): ask them to remove the cached views and unreachable objects for the commits listed above and the
   closed PR #218's refs, citing sensitive data. Until then the old commits may still open by SHA.
7. **Assume exposure.** The material was public from Nov 5, 2026 until removal, and forks, clones or caches may hold it. Treat the B1 v1.2.1
   prompt as disclosed, and decide whether the frozen article copies require any notice.

What this does NOT do: rewrite `main`, change any other branch, or change the private B1 history.
