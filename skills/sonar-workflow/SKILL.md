---
name: sonar-workflow
description: Run SonarQube static analysis, interpret results, and report quality gate status. Use when the user asks for code quality analysis, static analysis, or SonarQube scanning.
---

# Sonar Workflow

Use this skill for SonarQube analysis sessions in Codex.

## Metadata

- Runtime: `codex`
- Claude command: `commands/sonar.md`
- Claude agent: `agents/sonar-analyst.md`
- Command alias in Claude: `/sonar`

## Workflow

1. Load these source docs:
   - `../../commands/sonar.md`
   - `../../agents/sonar-analyst.md`
2. Check SonarQube health (`curl -sf http://localhost:9000/api/system/health`).
3. If not running, instruct user to start with `sonar-manage.sh up`.
4. Detect languages (`.csproj`/`.sln` for .NET, `package.json`/`tsconfig.json` for JS/TS).
5. Verify `sonar-project.properties` exists; if not, guide user to create one from templates.
6. Run appropriate scanner(s) via shell scripts in `infra/sonarqube/`.
7. Fetch and interpret results from SonarQube API.
8. For significant findings, read source files and explain with context.
9. End with quality gate summary and verdict.

## Language Routing

- C# / .NET work:
  - `../csharp-dotnet/SKILL.md`
  - `../csharp-dotnet/references/testing-nunit.md`
  - NUnit test method names: `[Action]_When[Scenario]_Then[Expectation]`
- TypeScript React / Next work:
  - `../typescript/SKILL.md`
  - `../typescript/references/react-next.md`

## Rules

- Always verify SonarQube is running before attempting analysis.
- Read flagged source code before explaining findings — never guess from descriptions alone.
- Prioritize bugs and vulnerabilities over code smells.
- Report the SonarQube dashboard URL for interactive exploration.
- Guide users through setup if `sonar-project.properties` is missing.
