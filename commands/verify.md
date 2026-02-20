---
description: Run build, type check, lint, and tests across detected languages. Outputs a PASS/FAIL verification report. Use before committing or opening a PR.
---

# Verify

Cross-language verification gate. Detects which languages are in the project and runs the appropriate toolchain.

## What This Command Does

1. **Detect languages** — scan for `.csproj`/`.sln`, `package.json`/`tsconfig.json`, `Cargo.toml`, `pyproject.toml`/`requirements.txt`
2. **Run build** — compile/transpile for each detected language
3. **Run type check** — static type analysis where applicable
4. **Run lint** — language-specific linter
5. **Run tests** — unit tests only (fast feedback, no Testcontainers)
6. **Check for issues** — console.logs, debug statements, TODO without tickets
7. **Report** — summary table with PASS/FAIL per check

## Verification Commands by Language

### C# / .NET
```bash
dotnet build --no-restore        # Build
dotnet test --no-build --filter "TestCategory=UnitTest"  # Unit tests only
```

### TypeScript
```bash
tsc --noEmit                     # Type check
eslint .                         # Lint (or biome)
jest / vitest / npm test         # Tests
```

### Rust
```bash
cargo check                      # Fast build check
cargo clippy -- -D warnings      # Lint (warnings = errors)
cargo test                       # Tests
```

### Python
```bash
mypy .                           # Type check (or pyright)
ruff check .                     # Lint
pytest -x --timeout=30           # Tests (fail fast)
```

## Output Format

```
VERIFICATION REPORT
═══════════════════

C# / .NET
  Build:      [OK / FAIL — error count]
  Tests:      [X passed, Y failed — unit only]

TypeScript
  Types:      [OK / X errors]
  Lint:       [OK / X issues]
  Tests:      [X passed, Y failed]

Rust
  Check:      [OK / FAIL]
  Clippy:     [OK / X warnings]
  Tests:      [X passed, Y failed]

Python
  Types:      [OK / X errors]
  Lint:       [OK / X issues]
  Tests:      [X passed, Y failed]

Secrets:      [OK / X found — grep for API keys, tokens, passwords]
Debug logs:   [OK / X found — console.log, Debug.Write, println!, print()]

VERDICT: PASS / FAIL
Ready for commit: YES / NO
```

## When to Use

- Before committing — quick sanity check
- Before opening a PR — full verification
- After a refactor — confirm nothing broke
- CI pre-merge gate — run in pipeline

## Important

- Runs **unit tests only** by default (fast). Use `dotnet test --filter "TestCategory=UnitTest|TestCategory=IntegrationTest"` for full suite.
- Stops on first failure per language — no point running tests if build fails.
- Only checks languages detected in the project root.