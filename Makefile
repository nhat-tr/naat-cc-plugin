.PHONY: validate validate-agents validate-commands validate-skills validate-sync

validate-agents:
	node scripts/ci/validate-agents.js

validate-commands:
	node scripts/ci/validate-commands.js

validate-skills:
	node scripts/ci/validate-skills.js

validate-sync:
	@echo "Checking for stale pair-signal.sh invocations in SKILL.md files..."
	@if grep -rn "bash.*pair-signal\.sh" skills/*/SKILL.md 2>/dev/null; then \
		echo "ERROR: SKILL.md files must use .pair/.ready signaling, not pair-signal.sh"; \
		exit 1; \
	fi
	@echo "OK"

validate: validate-agents validate-commands validate-skills validate-sync
