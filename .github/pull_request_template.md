## Why

What was broken or missing, and who hits it.

## What

What changed, in a few sentences. Call out behaviour that did **not** change if a reader might assume it did.

## Verification

- [ ] `npm test`
- [ ] `npm run build` (if the change can fail typecheck)
- [ ] `docker compose up -d --build` and `GET /api/status` returns ok (if runtime behaviour changed)
