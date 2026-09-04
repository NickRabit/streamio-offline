# Project rules

## Code style
- Write a minimum of comments. Only comment what is not obvious from the code itself;
  do not restate what a line already says.
- All comments, documentation and specifications must be written in English.
  (Older files still contain Czech comments — translate them only when you are
  already editing that code.)

## Git workflow
- For every task, create a branch off `main`.
- Commit only into that branch. Never merge it into `main` and never push
  directly to `main`.
- Leave the merge to the user.

## After implementing
- Deploy to the local Docker setup and verify the container comes up:

```
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 stremio-offline
```

  The app listens on `http://localhost:${STREMIO_OFFLINE_PORT:-8090}`, health
  endpoint `/api/status`.

## Useful commands
- `npm run build` — build web + server workspaces
- `npm test` — server test suite
- `npm run dev:server` / `npm run dev:web` — local dev
