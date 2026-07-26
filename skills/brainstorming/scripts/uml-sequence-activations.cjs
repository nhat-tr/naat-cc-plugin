'use strict';

// Activation-bar derivation for the UML sequence diagram. Kept out of uml-layout.ts — and
// free of geometry — so the semantics can be tested in node the way uml-elk-graph.cjs
// shares its sizing contract with the frontend. The layout turns the row indices returned
// here into y coordinates; nothing in this module knows about pixels.
//
// Each bar names the message that owns it, because a lifeline that does many things needs
// every bar traceable back to one action. A bar nobody can attribute is noise.

// A synchronous call hands control to the callee, so the callee is busy until it replies.
// An async message is fire-and-forget: it has no observable return, so opening a bar for it
// would draw something with no defined end. A self message is work the lifeline does inside
// its own row and returns from immediately.
const CALL_KINDS = new Set(['sync', 'create']);
const RETURN_KINDS = new Set(['reply', 'destroy']);

function messageKind(message) {
  const kind = typeof message.message_kind === 'string' ? message.message_kind : '';
  if (kind !== '') return kind;
  return message.from === message.to ? 'self' : 'sync';
}

// The row after which a lifeline does nothing more. An unanswered call ends there instead of
// running to the bottom of the diagram: a bar that outlives its lifeline's last message
// stacks up against every other unanswered bar and hides them all.
function lastParticipationRows(messages) {
  const lastRow = new Map();
  messages.forEach((message, row) => {
    lastRow.set(message.from, row);
    lastRow.set(message.to, row);
  });
  return lastRow;
}

function deriveSequenceActivations(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const lastRow = lastParticipationRows(rows);
  const openByLifeline = new Map();
  const activations = [];

  const open = (lifelineId, message, row) => {
    const stack = openByLifeline.get(lifelineId) ?? [];
    stack.push({ lifelineId, message, openRow: row, depth: stack.length });
    openByLifeline.set(lifelineId, stack);
  };

  const record = (entry, closeRow, terminator) => {
    activations.push({
      lifelineId: entry.lifelineId,
      messageId: entry.message.id,
      componentId: entry.message.component_id,
      label: entry.message.label,
      openRow: entry.openRow,
      closeRow,
      depth: entry.depth,
      terminator,
    });
  };

  rows.forEach((message, row) => {
    const kind = messageKind(message);
    if (RETURN_KINDS.has(kind)) {
      // A reply closes the innermost activation on the lifeline that sends it. A reply with
      // nothing open is a modelling slip, not a bar: pairing it with an unrelated call would
      // draw a bar spanning work that never happened.
      const entry = openByLifeline.get(message.from)?.pop();
      if (entry) record(entry, row, 'reply');
      return;
    }
    if (kind === 'self') {
      const depth = openByLifeline.get(message.to)?.length ?? 0;
      record({ lifelineId: message.to, message, openRow: row, depth }, row, 'self-return');
      return;
    }
    if (CALL_KINDS.has(kind)) open(message.to, message, row);
  });

  for (const stack of openByLifeline.values()) {
    for (const entry of stack) {
      const last = lastRow.get(entry.lifelineId);
      const closeRow = Math.max(entry.openRow, typeof last === 'number' ? last : entry.openRow);
      record(entry, closeRow, 'open-ended');
    }
  }

  // Outer bars paint first so a nested bar is never hidden behind its parent.
  return activations.sort((left, right) => (
    left.depth - right.depth
    || left.openRow - right.openRow
    || left.messageId.localeCompare(right.messageId)
  ));
}

module.exports = { deriveSequenceActivations };
