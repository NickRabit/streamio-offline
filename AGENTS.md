# Project Rules

## Code Style

- Write as few comments as possible. Add a comment only when the code cannot clearly communicate the intent on its own.
- Write all comments, documentation, and specifications in English.
- Translate existing non-English comments only when modifying the surrounding code.

## Git Workflow

- Write everything in English: commit messages, branch names, pull request titles and descriptions, and comments on issues or pull requests. Chat replies to the user stay in the language the user writes in.
- For every task, create a dedicated branch from `main` (or `master` if that is the repository's default branch).
- Commit task changes only to that branch.
- After committing, push the task branch and create a pull request targeting `main` or `master`.
- When that pull request ships a user-facing feature or fix, bump the patch version in the same PR before opening it. Keep `package.json`, `server/package.json`, `web/package.json`, and `package-lock.json` in sync. Bump minor or major only when the user asks. Skip the bump for docs, rules, and other non-shipping work.
- Never merge the task branch into `main` or `master`; leave merging to the user.

## After Implementation

- Deploy the result to the local Docker setup after implementation.
- Verify that the container starts and is healthy:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 stremio-offline
```

- Verify the health endpoint at `http://localhost:${STREMIO_OFFLINE_PORT:-8090}/api/status`.
