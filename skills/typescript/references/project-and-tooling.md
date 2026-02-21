# Project and Tooling Reference

Use this reference for repository layout, TypeScript configuration, and package manager behavior.

## Match Existing Repository Layout

Keep existing structure if the repository already has one. For new projects, this is a good baseline:

```text
src/
  components/
  features/
  lib/
  api/
  types/
  utils/
tests/
  unit/
  integration/
  e2e/
```

## TypeScript Compiler Defaults

Use strict settings for new projects, but do not force breakage in existing codebases:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

When tightening compiler flags in legacy repositories, scope changes to touched modules.

## Package Manager Detection

Resolve package manager in this order:

1. Lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `package-lock.json`)
2. `packageManager` field in `package.json`
3. fallback to npm if both are absent

## Script Conventions

Prefer repository-defined scripts (`lint`, `typecheck`, `test`, `test:e2e`) over ad hoc commands.

## Logging and Debugging

- Remove temporary debug logs before finishing.
- Use repository logging abstractions for production flows.
- Keep `console.error` only at boundary-level error handling where appropriate.
