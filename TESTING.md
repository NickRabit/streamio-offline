# Testing strategy

This document describes how the project is tested, and the plan for the layers
that are not built yet. It is written so that any phase can be picked up
independently of the others.

## Why

The client is where most of the recent bugs have been: mobile catalog layout,
title detail, landscape Safari chrome, sideways pans on the source list. All of
them were found by hand, on a device, after the fact. None of them would have
been caught by the server test suite.

The client also has no obvious seam for testing. `web/src/App.tsx` holds most of
the application state in one component, and responsive behaviour lives almost
entirely in CSS media queries -- which a DOM emulator does not evaluate at all.
The strategy below works with that reality instead of demanding a refactor
first: pure logic is unit tested, everything layout-shaped is tested in a real
browser.

## Layers

| Layer | Tool | Runs against | Purpose |
| --- | --- | --- | --- |
| L0 | `node:test` via `tsx` | `server/src` | Server logic. Exists today. |
| L1 | Vitest + Testing Library | `web/src`, jsdom | Pure client logic and components. |
| L2 | Playwright | Built app + real server + fake addon | End-to-end user journeys. |
| L3 | Playwright projects | Same, across viewports | Responsive layout, visual and accessibility regressions. |

### L0 -- server (existing)

`npm test` runs `tsx --test server/src/*.test.ts`. No change planned.

### L1 -- client unit and component tests

Runner: **Vitest** with the `jsdom` environment, sharing Vite's existing
transform pipeline so there is no second build configuration to keep in sync.

Highest value per line of test code, in order:

1. Pure modules with no DOM dependency -- `streams.ts` (size parsing from free
   text, sorting and filtering), `languages.ts` (flag and word detection),
   `log-groups.ts` (log parsing, fingerprinting, grouping).
2. Modules with a narrow DOM surface -- `clipboard.ts` (the secure-context
   fallback path that exists because the NAS serves over plain HTTP),
   `diagnostics.ts` (repeat suppression, host extraction).
3. `api.ts` error handling -- `ApiError` status and code propagation, the
   timeout branch, the 204 no-content branch.
4. Component tests for the small, self-contained components (`Login`, `Stats`),
   with HTTP mocked at the network boundary.

Two rules that keep this layer useful:

- **Mock at the network boundary, not at the module boundary.** Use `msw` for
  component tests rather than stubbing the `api` object, so the tests keep
  exercising `api.ts` and break when a route changes.
- **Never assert layout in jsdom.** jsdom does not apply CSS, so a media query
  test there proves nothing. Layout belongs to L3.

`App.tsx` is deliberately not the target of this layer. Rather than refactoring
it up front, pull pure logic (stream ranking, episode selection, filter
handling) out into modules opportunistically, whenever that part of the file is
being changed for another reason, and unit test it as it comes out.

### L2 -- end-to-end journeys

Runner: **Playwright**, driving the built web bundle served by the real server.
Config in `playwright.config.ts`, specs in `e2e/tests`, fixtures in
`e2e/fixtures`.

The fixture stack is two servers, both started by Playwright itself:

- `e2e/fixtures/addon-server.mjs` is a Stremio addon that answers from memory --
  one movie, one series with three episodes, and two sources per title that
  differ in size and language so ordering and filtering have something real to
  work on. It also serves a 4 kB MP4, so a queued download is a genuine
  transfer rather than a mock.
- `e2e/fixtures/app-server.mjs` starts the built server on a throwaway
  directory under `e2e/.tmp`, wiped at the start of every run. The state file is
  seeded with `defaultsInstalled: true`, which is what stops the server fetching
  Cinemeta and OpenSubtitles on first boot; `ALLOW_PRIVATE_ADDONS=1` is what
  lets the SSRF guard accept an addon on loopback. It also lays the built server
  and web bundles out the way the image does, because the server resolves its
  web root as `../../web` -- in a plain checkout that path is the unbuilt
  workspace.

Because there is one server with one state file, the specs run serially
(`workers: 1`) rather than fighting over it.

The `setup` project runs first and is a real journey, not scaffolding: a fresh
server has no account, so it creates one and installs the fake addon through the
UI. The session it leaves behind is reused by every other spec through
`storageState`.

Covered today: first-run account creation, adding an addon, sign-in and its
refusal, the open and closed API endpoints, browsing a catalog, search with and
without a match, a movie detail, a series episode list, source ordering and
language filtering, queueing a download through to a finished job, a setting
that survives a reload, and diagnostics.

The Playwright image has no ffmpeg, so the server logs a warning when it cannot
inspect the sample file. That is expected and does not affect the tests --
transcoding itself belongs to the server suite, not here.

### L3 -- responsive, visual, accessibility

Same Playwright installation, one set of tests run across several `projects`.
The viewports are chosen to sit on either side of the breakpoints that actually
exist in `web/src/style.css`:

| Project | Viewport | Covers |
| --- | --- | --- |
| `desktop` | 1440x900 | The >=981px layout: sidebar, two-column catalog |
| `desktop-short` | 1280x760 | The `max-height: 780px` series-sources branch |
| `tablet` | 820x1180, touch | The 701-980px band |
| `mobile` | 390x844 (iPhone 13) | The <=700px layout: bottom nav, 3-column poster grid |
| `mobile-landscape` | 844x390, touch | `max-width:980 and max-height:500 and orientation:landscape`, plus the `mobileLandscape` branch in `Player.tsx` |

The journey specs stay on one viewport -- they are about behaviour. Only the
specs under `e2e/tests/layout` run across the whole matrix.

Three kinds of assertion, in increasing order of maintenance cost:

**a) Layout invariants** (`e2e/tests/layout/invariants.spec.ts`). Deterministic,
no stored baselines, no upkeep. These catch the class of bug that has actually
been shipped:

- nothing escapes the page sideways, in any of the six views. Content inside a
  pane that scrolls horizontally on purpose -- the download table, a poster
  strip -- is exempt; only content that escapes the page itself counts.
- the navigation follows the 700px breakpoint: a full-height sidebar above it,
  a bar pinned to the bottom below it
- every navigation entry is inside the viewport without scrolling
- on touch projects, controls meet the 24px minimum from WCAG 2.2 AA (2.5.8).
  Anything roomier is a design choice and is deliberately not enforced, or the
  test would be dictating the layout rather than guarding it.
- no poster hangs past the edge of its grid

**b) Screenshot baselines** (`e2e/tests/layout/screenshots.spec.ts`). Four
screens -- catalog, a title detail with its sources, the library and settings --
across four of the five projects. They live in
`e2e/tests/layout/__screenshots__/<project>/`.

They are only comparable when every one of them is produced in the same place,
so they are always generated inside `mcr.microsoft.com/playwright:v1.56.1-noble`:

```
npm run test:e2e:snapshots
```

The **Update screenshot baselines** workflow does the same thing on a branch and
pushes the result, which is the easier path when a design change touches several
screens.

The image is what matters, not the machine: baselines generated in the container
on an Apple Silicon Mac match what the amd64 CI runner produces. Generating them
locally is fine.

Two decisions worth knowing about:

- **The tolerance is a fixed 120 pixels, not a percentage.** A 1% ratio sounds
  safe and is not: bumping the poster title from 12px to 16px stayed under it on
  every screen. Runs inside the container are byte-stable, so the small fixed
  budget only has to absorb renderer noise.
- **`desktop-short` has no baselines.** These four screens look the same at
  1280x760 as at 1440x900. That project earns its place through the invariants,
  which cover the 780px height rule; a megabyte of near-identical images does
  not.

**What baselines do not cover here.** Most of this app's content lives inside
panes that scroll on their own -- the poster grid, the source list, the episode
list. `fullPage` does not expand those, so a baseline captures the frame and
whatever is above the inner scroll boundary. That is genuinely where the
regressions have been (navigation placement, a clipped toolbar, landscape
chrome), but a change to a poster tile's title, three rows down inside the grid,
will not show up. Do not read a passing baseline as "the screen is unchanged".

**c) Accessibility** (`e2e/tests/layout/accessibility.spec.ts`).
`@axe-core/playwright` on the same matrix, WCAG 2.0 and 2.1 at A and AA. It
decides what can be decided from the DOM; keyboard order and screen reader
wording still need a person.

Running this matrix for the first time found three real defects, which are fixed
in the same change: the library toolbar was clipped below 700px so its last
control could not be reached at all; the catalog filters lost their accessible
names in landscape, where the CSS hides the label text; and the download queue
scrolled sideways without being reachable from the keyboard.

Chromium is enough to start. WebKit is worth adding for Safari-shaped bugs, but
note that Playwright's WebKit is not iOS Safari -- it does not reproduce the
mobile browser chrome, the collapsing URL bar, or the safe-area behaviour that
caused several of the landscape fixes. Those still need a real device.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`,
and is also callable from `image.yml` through `workflow_call` so the release
path does not duplicate the checks.

Jobs:

1. `check` -- type-check both workspaces, run the server suite and the web unit
   suite. Roughly one to two minutes.
2. `e2e` (from phase 2) -- runs inside the Playwright container image, covering
   L2 and L3, sharded across the viewport matrix.
3. On failure, the Playwright HTML report and any image diffs are uploaded as
   build artifacts.

Screenshot baselines are refreshed through a separate manually triggered
workflow that regenerates them in the container and pushes the result to the
pull request branch, so updating them is not a local-environment chore.

## Phases

| Phase | Content | Status |
| --- | --- | --- |
| 1 | `ci.yml` on pull requests, Vitest set up, unit tests for pure client logic | Done |
| 2 | Playwright plus the fixture stack, first end-to-end journeys | Done |
| 3 | Viewport matrix, layout invariants, accessibility checks | Done |
| 4 | Screenshot baselines and the container workflow that updates them | Done |

Phase 3 came before phase 4 on purpose. Layout invariants catch most real
regressions and need no maintenance; screenshots are convincing but are a
recurring source of noise, so they were added last and kept to a small number of
screens.

## Commands

```
npm test                 # server and client unit suites
npm test -w server       # server only
npm test -w web          # client unit tests
npm run test:watch -w web

npm run test:e2e            # Playwright, using a locally installed browser
npm run test:e2e:docker     # the same run inside the image CI uses
npm run test:e2e:snapshots  # regenerate the screenshot baselines
```

`npm run test:e2e` needs the browser on the machine
(`npx playwright install chromium`). `npm run test:e2e:docker` needs nothing but
Docker, builds first, and matches CI exactly -- use it when a result has to be
comparable, and always once screenshot baselines exist.
