# Music Trainer

Singing voice trainer and converter

Vite + React 19 + TypeScript, scaffolded 2026-10-19.

## Commands

| Task | Command |
|------|---------|
| Install | `npm install` |
| Dev server | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Build | `npm run build` |

## What is set up

- **Strict TypeScript** — including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. These catch real bugs; prefer fixing the code over
  loosening the config.
- **`@/*` path alias** → `src/*`, declared in both `tsconfig.json` and
  `vite.config.ts`. Change both or neither.
- **Vitest** with jsdom, globals on. One smoke test in `src/App.test.tsx`.
- **Token-first CSS** in `src/styles/tokens.css`. Components reference tokens.

## Not set up on purpose

No router, state library, UI kit, or linter. Add them when a real requirement
appears rather than up front — see the workspace `CLAUDE.md` on YAGNI.
