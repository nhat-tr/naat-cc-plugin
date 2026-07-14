import { MessageSquarePlus } from "lucide-react";
import { useRef, useState } from "react";

import { type Annotation, type FeedbackDraft } from "../app/feedback-store";
import { type FeedbackComponentOption } from "./FeedbackPanel";

interface AnnotationComposerProps {
  annotationComponentId: string;
  components: FeedbackComponentOption[];
  draft: FeedbackDraft;
  onAnnotationComponentSelect: (componentId: string) => void;
  onDraftChange: (draft: FeedbackDraft) => void;
  readOnly: boolean;
}

export function AnnotationComposer({
  annotationComponentId,
  components,
  draft,
  onAnnotationComponentSelect,
  onDraftChange,
  readOnly,
}: AnnotationComposerProps) {
  const [annotationText, setAnnotationText] = useState("");
  const annotationInput = useRef<HTMLTextAreaElement>(null);
  const effectiveTarget = components.find(component => component.id === annotationComponentId)
    ?? components[0];
  const effectiveTargetId = effectiveTarget?.id ?? "";

  const addAnnotation = (): void => {
    const comment = annotationText.trim();
    if (!effectiveTarget || !comment || draft.annotations.length >= 50) return;
    const annotation: Annotation = {
      id: globalThis.crypto?.randomUUID?.() ?? `note-${Date.now()}`,
      comment,
      target: { componentId: effectiveTarget.id, label: effectiveTarget.label },
    };
    onDraftChange({ ...draft, annotations: [...draft.annotations, annotation] });
    setAnnotationText("");
    annotationInput.current?.focus();
  };

  return (
    <div className="annotation-compose">
      <label htmlFor="feedback-target">Component</label>
      <select
        disabled={readOnly || components.length === 0}
        id="feedback-target"
        onChange={event => onAnnotationComponentSelect(event.target.value)}
        value={effectiveTargetId}
      >
        {components.map(component => <option key={component.id} value={component.id}>{component.label}</option>)}
      </select>
      <span className="sr-only" role="status">
        {effectiveTarget
          ? `Annotation Component: ${effectiveTarget.label}`
          : "No Annotation Component available."}
      </span>
      <label htmlFor="annotation-comment">Targeted note</label>
      <textarea
        disabled={readOnly}
        id="annotation-comment"
        maxLength={4_000}
        onChange={event => setAnnotationText(event.target.value)}
        placeholder="What should change or be clarified?"
        ref={annotationInput}
        value={annotationText}
      />
      <button
        className="quiet-button"
        disabled={readOnly || !annotationText.trim() || components.length === 0}
        onClick={addAnnotation}
        type="button"
      >
        <MessageSquarePlus aria-hidden="true" size={16} />
        Add targeted note
      </button>
    </div>
  );
}
