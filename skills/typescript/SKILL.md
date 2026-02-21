---
name: typescript
description: TypeScript implementation guidance for frontend and backend repositories. Use when writing or modifying TypeScript code, designing React or Next.js components, building Node.js APIs, enforcing type safety, handling async and performance concerns, or adding tests with Vitest, Jest, React Testing Library, or Playwright. Start by matching existing repository conventions, framework versions, and package manager choices.
---

# TypeScript Implementation Workflow

Use this skill to make production-safe TypeScript changes that align with repository conventions.

## Execute This Workflow

1. Inspect project constraints and toolchain before editing.
2. Match existing architecture, style, and runtime assumptions.
3. Load only the relevant reference file(s) for the task.
4. Implement the smallest behaviorally correct change.
5. Validate with lint, typecheck, and tests; report any unverified areas.

## Inspect Constraints First

Run these checks before choosing patterns:

- `rg --files -g 'package.json' -g 'tsconfig*.json'`
- `rg -n '"typescript"|"strict"|"noUncheckedIndexedAccess"|"module"|"target"' package.json tsconfig*.json`
- `rg -n '"react"|"next"|"express"|"fastify"|"hono"|"nestjs"' package.json`
- `rg -n '"vitest"|"jest"|"playwright"|"@testing-library"' package.json`
- `ls -1 pnpm-lock.yaml yarn.lock bun.lockb package-lock.json 2>/dev/null`

Preserve compatibility with existing framework versions and build tooling.

## Apply Guardrails

- Prefer `strict`-safe typing and avoid `any` in new code.
- Prefer narrowing and runtime validation at boundaries.
- Keep React hooks dependency arrays complete.
- Avoid floating promises in backend and UI async flows.
- Prefer clear immutable updates over in-place mutation.
- Replace debug `console.log` in production paths with repo-standard logging.
- Avoid broad refactors unless explicitly requested.

## Reference Map

Read only what is relevant:

- `references/project-and-tooling.md`: project structure, TS config defaults, package manager and script conventions.
- `references/type-safety.md`: strict typing, unions, narrowing, schema validation, and API shape design.
- `references/react-next.md`: React component patterns, Next.js server/client boundaries, and UI performance patterns.
- `references/node-backend.md`: Node API patterns, validation, errors, and data-access safety.
- `references/async-and-performance.md`: async composition, retries, cancellation, and performance tradeoffs.
- `references/testing.md`: test strategy across unit, component, and E2E layers.

## Deliverable Expectations

When implementing changes:

- Explain compatibility decisions (for example, why a framework-specific pattern was used or skipped).
- Add or update tests when behavior changes.
- Provide exact validation commands run, or clearly state what could not be run.
