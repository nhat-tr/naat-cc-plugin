import { createRoot } from "react-dom/client";

import { VisualCompanionApp } from "./app/VisualCompanionApp";
import {
  annotationSummary,
  computeComponentChanges,
  deriveCommittedChoices,
  deriveFeedbackThreadState,
  filterSessionEventsForRevision,
  groupAnnotationsByComponent,
  isChoiceSelected,
  mergeChoiceState,
  normalizeFeedbackDraft,
  parseInlineSegments,
  parseMessageBlocks,
  parseRevisionSnapshots,
  readResponseError,
  reconcileChoices,
} from "./app/feedback-store";
import { deriveBrowserDeliveryState } from "./app/session-client";

export {
  annotationSummary,
  computeComponentChanges,
  deriveCommittedChoices,
  deriveFeedbackThreadState,
  filterSessionEventsForRevision,
  groupAnnotationsByComponent,
  isChoiceSelected,
  mergeChoiceState,
  normalizeFeedbackDraft,
  parseInlineSegments,
  parseMessageBlocks,
  parseRevisionSnapshots,
  readResponseError,
  reconcileChoices,
  deriveBrowserDeliveryState,
};

if (typeof document !== "undefined") {
  const host = document.getElementById("visual-shell-root");
  if (!host) throw new Error("Visual Shell requires #visual-shell-root");
  createRoot(host).render(<VisualCompanionApp />);
}
