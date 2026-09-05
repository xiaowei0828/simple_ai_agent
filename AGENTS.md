# Project instructions

- This repository is an educational code agent, so keep the control flow explicit and easy to trace.
- Prefer small, dependency-light modules over framework abstractions.
- Preserve the approval boundary: workspace apply_patch operations are automatically approved; external file changes and process execution require host confirmation unless --yes is set.
- Run `npm run typecheck` and `npm test` after changing TypeScript behavior.
