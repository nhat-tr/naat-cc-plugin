// One redaction rule set for every surface that persists text a provider or human wrote: Pair evidence
// (pair-store) and Agent Conversation Checkpoints (pair-state). The two carried private near-copies and
// drifted — pair-state learned quoted assignments, env-var pairs, and JWTs while pair-store did not — so
// the exact shapes a sealed handover refuses were stored verbatim as Pair evidence, and the
// whitespace-over-redaction fix had to be applied twice, by hand, in two divergent forms.

const CREDENTIAL_WORD = 'api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|private[-_]?key';
// Keys that only mean "credential" in an assignment position, never as a bare prose word.
const CREDENTIAL_KEY = `${CREDENTIAL_WORD}|authorization|cookie`;

// A bare credential word followed by a space is ordinary English — "assumes the token survives a
// 1.5 h walk" is prose, not a leak. Redacting on whitespace alone ate the next word out of every
// Design Check, Architecture Risk, finding, and Agent Conversation Checkpoint that discussed tokens or
// secrets, which is evidence corruption in the material a human decision rests on. A flag still redacts
// on whitespace (`--token abc`); a bare word needs an assignment separator. High-entropy credential
// shapes are matched on their own and never depend on a surrounding word.
function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,"']+/giu, 'Bearer [REDACTED]')
    .replace(new RegExp(`(--?(?:${CREDENTIAL_WORD})(?:=|\\s+))[^\\s,"']+`, 'giu'), '$1[REDACTED]')
    .replace(new RegExp(`(["']?(?:${CREDENTIAL_KEY})["']?\\s*[:=]\\s*)(["'])([^"'\\r\\n]+)\\2`, 'giu'), '$1$2[REDACTED]$2')
    // `Bearer` is not the value: the Bearer rule above already redacted what followed it.
    .replace(new RegExp(`(["']?(?:${CREDENTIAL_KEY})["']?\\s*[:=]\\s*)(?!["']|Bearer\\b)[^\\s,;]+`, 'giu'), '$1[REDACTED]')
    .replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*[^\s,"']+/gu, '[REDACTED]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[oprsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/gu, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]');
}

module.exports = { CREDENTIAL_WORD, redactString };
