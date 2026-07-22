#!/usr/bin/env node
/**
 * Validate hooks.json schema and coordinated handover topology.
 */

const fs = require('fs');
const path = require('path');

const HOOKS_FILE = process.env.HOOKS_FILE || path.join(__dirname, '../../hooks/hooks.json');
const VALID_EVENTS = ['PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'Stop', 'Notification', 'SubagentStop', 'UserPromptSubmit'];

function validateHookEntry(hook, label) {
  let hasErrors = false;

  if (!hook.type || typeof hook.type !== 'string') {
    console.error(`ERROR: ${label} missing or invalid 'type' field`);
    hasErrors = true;
  }

  if (!hook.command || (typeof hook.command !== 'string' && !Array.isArray(hook.command))) {
    console.error(`ERROR: ${label} missing or invalid 'command' field`);
    hasErrors = true;
  }

  return hasErrors;
}

function managedHookCommands(hooks, eventType) {
  return (hooks[eventType] || [])
    .flatMap(matcher => Array.isArray(matcher.hooks) ? matcher.hooks : [])
    .map(hook => hook.command)
    .filter(command => typeof command === 'string' && command.includes('my-claude-code/hooks/'));
}

function validateHandoverTopology(hooks) {
  let hasErrors = false;
  const promptCommands = managedHookCommands(hooks, 'UserPromptSubmit');
  const stopCommands = managedHookCommands(hooks, 'Stop');

  if (promptCommands.length !== 1 || !promptCommands[0].includes('handover-gate.sh')) {
    console.error('ERROR: UserPromptSubmit must have exactly one managed handover-gate hook');
    hasErrors = true;
  }
  if (
    stopCommands.length !== 1 ||
    !stopCommands[0].includes('stop-gate.sh') ||
    stopCommands[0].includes('handover-gate.sh')
  ) {
    console.error('ERROR: Stop must have exactly one coordinated managed Stop hook');
    hasErrors = true;
  }

  return hasErrors;
}

function validateHooks() {
  if (!fs.existsSync(HOOKS_FILE)) {
    console.log('No hooks.json found, skipping');
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf-8'));
  } catch (e) {
    console.error(`ERROR: Invalid JSON in hooks.json: ${e.message}`);
    process.exit(1);
  }

  const hooks = data.hooks || data;
  let hasErrors = false;
  let totalMatchers = 0;

  if (typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const [eventType, matchers] of Object.entries(hooks)) {
      if (!VALID_EVENTS.includes(eventType)) {
        console.error(`ERROR: Invalid event type: ${eventType}`);
        hasErrors = true;
        continue;
      }

      if (!Array.isArray(matchers)) {
        console.error(`ERROR: ${eventType} must be an array`);
        hasErrors = true;
        continue;
      }

      for (let i = 0; i < matchers.length; i++) {
        const matcher = matchers[i];
        if (typeof matcher.matcher !== 'string') {
          console.error(`ERROR: ${eventType}[${i}] missing 'matcher' field`);
          hasErrors = true;
        }
        if (!matcher.hooks || !Array.isArray(matcher.hooks)) {
          console.error(`ERROR: ${eventType}[${i}] missing 'hooks' array`);
          hasErrors = true;
        } else {
          for (let j = 0; j < matcher.hooks.length; j++) {
            if (validateHookEntry(matcher.hooks[j], `${eventType}[${i}].hooks[${j}]`)) {
              hasErrors = true;
            }
          }
        }
        totalMatchers++;
      }
    }
  } else {
    console.error('ERROR: hooks.json must be an object with event type keys');
    process.exit(1);
  }

  if (validateHandoverTopology(hooks)) hasErrors = true;

  if (hasErrors) process.exit(1);
  console.log(`Validated ${totalMatchers} hook matchers`);
}

validateHooks();
