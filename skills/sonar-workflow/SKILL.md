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
2. Determine target: SonarCloud (`https://sonarcloud.io`) or local SonarQube (`http://localhost:9000`).
   - SonarCloud: check `SONAR_TOKEN` env var is set; verify reachability with `curl -sf https://sonarcloud.io/api/system/status`.
   - Local: check health with `curl -sf http://localhost:9000/api/system/health`; if not running, instruct user to start with `sonar-manage.sh up`.
3. Resolve project config: prefer `sonar-project.properties`; fall back to `.sonarlint/*.json` (contains `projectKey`, `sonarCloudOrganization`, `region`).
4. Detect languages (`.csproj`/`.sln` for .NET, `package.json`/`tsconfig.json` for JS/TS).
5. Run appropriate scanner(s) via shell scripts in `infra/sonarqube/`.
6. Fetch results from the SonarCloud/SonarQube API and write to `/tmp/sonar-results-<timestamp>.json`.
7. **Report temp file path and ask user to review** before proceeding (user decides whether to interpret and fix).
8. Once approved, read flagged source files and explain findings with context.
9. End with quality gate summary and verdict.

## Language Routing (REQUIRED)

Read `~/.claude/CLAUDE.md` (Claude Code) or `~/.codex/AGENTS.md` / `~/.agents/AGENTS.md` (Codex) → find the absolute path under "Global Language Rules" → `Read` that skill file. All rules in section 2 (Non-Negotiable Rules) apply when interpreting SonarQube findings.

- **C# / .NET**: Read the C# skill file + testing reference.
- **TypeScript / React / Next**: Read the TypeScript skill file + react-next reference.

## Rules

- Always verify the target (SonarCloud or local) is reachable before attempting analysis.
- For SonarCloud, `SONAR_TOKEN` must be set; never proceed without it.
- Read flagged source code before explaining findings — never guess from descriptions alone.
- Prioritize bugs and vulnerabilities over code smells.
- Report the dashboard URL for interactive exploration (`https://sonarcloud.io/project/overview?id=<projectKey>` for SonarCloud).
- If neither `sonar-project.properties` nor `.sonarlint/*.json` is found, guide the user to create one from templates.
