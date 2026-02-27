.PHONY: validate validate-agents validate-commands validate-skills

validate-agents:
	node scripts/ci/validate-agents.js

validate-commands:
	node scripts/ci/validate-commands.js

validate-skills:
	node scripts/ci/validate-skills.js

validate: validate-agents validate-commands validate-skills
