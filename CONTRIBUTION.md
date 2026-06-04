# Contributing to Remote Video Synchronizer (RVS)

Thanks for working on RVS! This guide describes the day-to-day development
workflow — branching, linting, and (most importantly) **when to bump the
extension version**, since that single field drives the automated Chrome Web
Store release.

---

## TL;DR

- Work on a **branch**, open a **PR into `main`** — never push to `main` directly.
- Run `npm run lint` before pushing.
- **Only bump `extension/manifest.json` `version` when you intend to ship a
  release.** Merging a version bump to `main` automatically publishes to the
  Chrome Web Store and cuts a GitHub Release. Regular code/doc changes must
  leave the version untouched.

---

## 1. Project Setup

```bash
npm install        # install ws (runtime) + lint/type tooling (dev)
npm start          # run the signaling server at ws://127.0.0.1:8080
```

Load the extension unpacked from `chrome://extensions/` (**Developer mode →
Load unpacked → select `extension/`**). See the
[README](README.md#-getting-started) for the full local setup.

---

## 2. Branching & Pull Requests

All changes land on `main` through a pull request. Branches follow a
`type/short-description` convention, matching the history:

| Prefix   | Use for                                             |
| :------- | :-------------------------------------------------- |
| `feat/`  | New user-facing functionality                       |
| `fix/`   | Bug fixes                                            |
| `chore/` | Tooling, dependencies, config (no behavior change)  |
| `docs/`  | Documentation only                                  |
| `ci/`    | GitHub Actions / workflow changes                   |

Example: `git checkout -b fix/popup-title-layout`.

Keep commit messages in the imperative mood (e.g. *"Fix race where reconnecting
tears down the new WebSocket"*). Open the PR against `main` and let the checks
run before merging.

---

## 3. Code Style & Linting

The repo uses **ESLint** (flat config) and **Prettier**:

```bash
npm run lint                 # ESLint over server.js + extension/**
npx prettier --check .       # verify formatting
npx prettier --write .       # auto-format
```

Prettier settings (`.prettierrc`): single quotes, no semicolons, 2-space indent.
`jsconfig.json` enables editor type-checking against the `@types/*` packages, so
keep new code type-clean.

Project conventions worth preserving:

- **No `innerHTML`.** Build DOM with `textContent` / `createElement` (XSS safety).
- The WebSocket lives in `background.js` (the service worker), **not** in
  `content.js` — Netflix's page CSP blocks `wss://` from a content script.
- On Netflix, never write `video.currentTime` / `.play()` / `.pause()` directly;
  route commands through `netflix-bridge.js` to avoid the **M7375** tamper error.

See [docs/implementation_plan.md](docs/implementation_plan.md) for the full
architecture and the reasoning behind these constraints.

---

## 4. Versioning & Releasing

RVS ships from a single source of truth: the `version` field in
[`extension/manifest.json`](extension/manifest.json) (currently `1.1.3`). It uses
[Semantic Versioning](https://semver.org/) — `MAJOR.MINOR.PATCH`.

> [!IMPORTANT]
> **Do not bump the version for ordinary changes.** A bug fix, refactor,
> documentation edit, or CI tweak should leave `version` exactly as it is. Bump
> it **only** in the PR that you intend to publish as a release.

### How the automation works

Two GitHub Actions workflows watch `extension/**`:

| Workflow                       | Trigger                          | What it does |
| :----------------------------- | :------------------------------- | :----------- |
| `extension-publish-test.yml`   | PR into `main` touching `extension/**` | If the PR bumps the version, uploads a **draft** to the Chrome Web Store (`publish: false`) to verify packaging + credentials. Nothing goes public. |
| `extension-publish.yml`        | Push to `main` touching `extension/**` | If the merged commit bumped the version, **publishes** to the Chrome Web Store, tags the commit `vX.Y.Z`, and creates a GitHub Release with auto-generated notes. |

Both workflows compare the current `manifest.json` version against the previous
state (the PR base, or `HEAD^` on `main`):

- **Version unchanged** → nothing is published. This is why touching
  `extension/content.js` (or any other `extension/**` file) without a bump is
  safe and will **not** trigger a republish.
- **Version increased** (strictly greater, per `sort -V`) → publish proceeds.
- **Version changed but not greater** (e.g. a downgrade) → skipped with a warning.

### Cutting a release

1. Create a release branch, e.g. `git checkout -b chore/release-1.1.4`.
2. Bump `version` in `extension/manifest.json` (e.g. `1.1.3` → `1.1.4`) following
   SemVer:
   - **PATCH** — bug fixes, no behavior change for users.
   - **MINOR** — new backward-compatible functionality.
   - **MAJOR** — breaking changes.
3. Include the actual feature/fix changes in the same PR (or merge them first and
   bump in a dedicated PR — either works, as long as the bump lands on `main`).
4. Open the PR. The **publish-test** workflow uploads a draft so you can confirm
   packaging succeeds before merging.
5. Merge to `main`. The **publish** workflow publishes to the Chrome Web Store,
   pushes the `vX.Y.Z` tag, and creates the matching GitHub Release.

> Note: `package.json` has its own `version` (the signaling server) that is
> **independent** of the extension. Release tags track the **manifest** version.

---

## 5. Before You Open a PR — Checklist

- [ ] Branch named `type/short-description`, targeting `main`.
- [ ] `npm run lint` passes and code is Prettier-formatted.
- [ ] No `innerHTML`; Netflix writes still go through `netflix-bridge.js`.
- [ ] Manually verified sync between two tabs (see
      [docs/walkthrough.md](docs/walkthrough.md)).
- [ ] `extension/manifest.json` `version` bumped **only if** this PR is a release.
- [ ] Docs updated if behavior or configuration changed.
