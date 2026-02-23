---
description: Run SonarQube static analysis on the current project, interpret results, and report quality gate status. Requires a local SonarQube instance.
---

# Sonar

Run SonarQube static analysis and interpret results for the current project.

## What This Command Does

1. **Check SonarQube** — verify SonarQube is running at `http://localhost:9000`. If not, suggest `sonar-manage.sh up`.
2. **Detect languages** — scan for `.csproj`/`.sln` (C#/.NET), `package.json`/`tsconfig.json` (JS/TS).
3. **Check project config** — look for `sonar-project.properties` in project root. If missing, guide the user through creating one from templates.
4. **Run scanner(s)** — invoke the appropriate scanner script:
   - .NET: `scan-dotnet.sh`
   - JS/TS: `scan-frontend.sh`
   - Fullstack: both scanners with separate project keys
5. **Fetch results** — poll SonarQube API until analysis completes.
6. **Interpret findings** — read flagged source files, explain each significant finding with context, suggest fixes.
7. **Report** — structured summary grouped by severity.

## Scanner Scripts

All scripts live in the toolkit at `infra/sonarqube/`:

```bash
./sonar-manage.sh up           # Start SonarQube
./sonar-manage.sh status       # Check health
./scan-dotnet.sh [key]         # .NET scanner
./scan-frontend.sh [key]       # JS/TS scanner
./fetch-results.sh <key>       # Fetch results from API
```

## Output Format

```
SONARQUBE ANALYSIS REPORT
═════════════════════════

Project: <project-key>
Server:  http://localhost:9000

ISSUES SUMMARY
══════════════
  BLOCKER      0
  CRITICAL     1
  MAJOR        3
  MINOR        5
  INFO         2
  ────────────────
  TOTAL        11

  By Type:
    BUG                  1
    VULNERABILITY        1
    CODE_SMELL           7
    SECURITY_HOTSPOT     2

QUALITY GATE
════════════
  Status: PASSED / FAILED

  Conditions:
    new_reliability_rating               OK
    new_security_rating                  OK
    new_maintainability_rating           OK
    new_coverage                         ERROR

SIGNIFICANT FINDINGS
════════════════════

[CRITICAL] SQL injection in raw query
File: src/Data/UserRepository.cs:42
Issue: String concatenation in FromSqlRaw creates SQL injection vector
Fix: Use FromSql with interpolation for auto-parameterization

VERDICT: PASS / FAIL
```

## When to Use

- Before opening a PR — deeper analysis than `/verify`
- When investigating code quality trends
- After major refactors — check for introduced issues
- Security audits — find vulnerabilities and security hotspots

## Important

- SonarQube must be running locally. Start with `sonar-manage.sh up`.
- First analysis of a project takes longer (initial indexing).
- Results accumulate over time — SonarQube tracks new vs. existing issues.
- Default setup uses anonymous auth. For tokens, pass as third arg to scanner scripts.
