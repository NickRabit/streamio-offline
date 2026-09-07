# Project rules

The single set of rules for any coding agent working in this repository.
`CLAUDE.md` points here; do not duplicate content in it.

## Code style

- Write a minimum of comments. Only comment what is not obvious from the code
  itself; do not restate what a line already says.
- All comments, documentation and specifications must be written in English.
  Older files still contain Czech comments — translate them only when you are
  already editing that code. The application UI stays Czech.

## Git workflow

- Write everything in English: commit messages, branch names, pull request
  titles and descriptions, and comments on issues or pull requests. Chat replies
  to the user stay in the language the user writes in.
- For every task, create a branch off `main`.
- Commit only into that branch. Never merge it into `main` and never push
  directly to `main`.
- After committing, push the task branch and open a pull request targeting
  `main`. Leave the merge to the user.
- When that pull request ships a user-facing feature or fix, bump the patch
  version in the same PR before opening it. Keep `package.json`,
  `server/package.json`, `web/package.json`, and `package-lock.json` in sync.
  Bump minor or major only when the user asks. Skip the bump for docs, rules,
  and other non-shipping work.

## After implementing

Deploy to the local Docker setup and verify the container comes up:

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 stremio-offline
```

The app listens on `http://localhost:${STREMIO_OFFLINE_PORT:-8090}`, health
endpoint `/api/status`, which must return `{"status":"ok",…}`.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run build` | Build the web and server workspaces |
| `npm test` | Server (`node:test`) and client (Vitest) unit suites |
| `npm run test:e2e:docker` | Playwright end-to-end suite in the CI image |
| `npm run dev:server` / `npm run dev:web` | Local dev servers |

## Where things are documented

| Topic | File |
| --- | --- |
| Test layers and what belongs where | [docs/testing.md](docs/testing.md) |
| Backlog and product direction | [docs/roadmap.md](docs/roadmap.md) |
| Environment variables | [docs/configuration.md](docs/configuration.md) |
| Contributor workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |

Some working documents are deliberately untracked (see `.gitignore`). Read them
if they exist locally, but do not add them to git.
