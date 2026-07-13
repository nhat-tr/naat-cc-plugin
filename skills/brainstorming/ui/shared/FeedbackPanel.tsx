import { MessageSquarePlus, RotateCcw, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  type Annotation,
  type Choice,
  type FeedbackDraft,
  type FeedbackThread,
  type FeedbackThreadStatus,
  type SessionEvent,
} from "../app/feedback-store";
import type { BrowserDeliveryState } from "../app/session-client";
import { DeliveryStatus } from "./DeliveryStatus";
import { InlineText, MessageBlocks } from "./InlineText";

export interface FeedbackComponentOption {
  id: string;
  label: string;
}

export interface PresentedFeedbackThread extends FeedbackThread {
  presentedStatus: FeedbackThreadStatus;
}

interface FeedbackPanelProps {
  components: FeedbackComponentOption[];
  draft: FeedbackDraft;
  deliveryState: BrowserDeliveryState;
  error: string | null;
  events: SessionEvent[];
  onClear: () => void;
  onDraftChange: (draft: FeedbackDraft) => void;
  onRefresh: () => void;
  onSubmit: () => void;
  readOnly: boolean;
  submitting: boolean;
  threads: PresentedFeedbackThread[];
}

function MessageBody({ message }: { message: string }) {
  return <MessageBlocks value={message} />;
}

function eventTitle(event: SessionEvent): string {
  return event.role === "agent" ? "Agent" : "You";
}

function historyMessage(event: SessionEvent): string {
  if (event.message) return event.message;
  return event.role === "user" ? "Visual feedback saved." : "Response received.";
}

function ThreadItem({ thread }: { thread: PresentedFeedbackThread }) {
  return (
    <article className={`thread-item thread-${thread.presentedStatus}`}>
      <header>
        <span className="thread-type">{thread.type}</span>
        <span
          className="thread-state"
          data-primitive="flag"
          data-tone={thread.presentedStatus === "outdated" ? "warning" : thread.presentedStatus}
        >
          {thread.presentedStatus}
        </span>
      </header>
      <p><InlineText value={thread.comment} /></p>
      {thread.replies.map(reply => (
        <div className="thread-reply" key={reply.id}>
          <strong>{reply.author}</strong>
          <p><InlineText value={reply.text} /></p>
        </div>
      ))}
    </article>
  );
}

export function FeedbackPanel({
  components,
  draft,
  deliveryState,
  error,
  events,
  onClear,
  onDraftChange,
  onRefresh,
  onSubmit,
  readOnly,
  submitting,
  threads,
}: FeedbackPanelProps) {
  const [targetId, setTargetId] = useState(components[0]?.id ?? "");
  const [annotationText, setAnnotationText] = useState("");
  const annotationInput = useRef<HTMLTextAreaElement>(null);
  const effectiveTargetId = components.some(component => component.id === targetId)
    ? targetId
    : components[0]?.id ?? "";
  const canSubmit = !readOnly && !submitting && Boolean(
    draft.message.trim() || draft.annotations.length || draft.choices.length,
  );

  useEffect(() => {
    if (!components.some(component => component.id === targetId)) {
      setTargetId(components[0]?.id ?? "");
    }
  }, [components, targetId]);

  const addAnnotation = (): void => {
    const target = components.find(component => component.id === effectiveTargetId);
    const comment = annotationText.trim();
    if (!target || !comment || draft.annotations.length >= 50) return;
    const annotation: Annotation = {
      id: globalThis.crypto?.randomUUID?.() ?? `note-${Date.now()}`,
      comment,
      target: { componentId: target.id, label: target.label },
    };
    onDraftChange({ ...draft, annotations: [...draft.annotations, annotation] });
    setAnnotationText("");
    annotationInput.current?.focus();
  };

  const removeAnnotation = (annotationId: string): void => {
    onDraftChange({ ...draft, annotations: draft.annotations.filter(item => item.id !== annotationId) });
  };

  const removeChoice = (choice: Choice): void => {
    onDraftChange({ ...draft, choices: draft.choices.filter(item => item.componentId !== choice.componentId) });
  };

  return (
    <aside className="feedback-panel" aria-label="Feedback batch">
      <header className="feedback-header">
        <div>
          <div className="eyebrow">Feedback Batch</div>
          <h2>Review notes</h2>
        </div>
        <DeliveryStatus readOnly={readOnly} state={deliveryState} />
      </header>

      <section className="feedback-thread-gutter" aria-labelledby="thread-heading">
        <div className="feedback-section-heading">
          <h3 id="thread-heading">Feedback Threads</h3>
          <span>{threads.length}</span>
        </div>
        <div className="thread-list">
          {threads.length > 0
            ? threads.map(thread => <ThreadItem key={thread.id} thread={thread} />)
            : <p className="history-empty">No threads on this Frame.</p>}
        </div>
      </section>

      <section className="feedback-compose" aria-labelledby="compose-heading">
        <div className="feedback-section-heading">
          <h3 id="compose-heading">Draft feedback</h3>
          <div className="feedback-tools">
            <button className="icon-button" disabled={readOnly} onClick={onClear} title="Clear feedback draft" type="button">
              <Trash2 aria-hidden="true" size={16} />
              <span className="sr-only">Clear feedback draft</span>
            </button>
            <button className="icon-button" disabled={readOnly} onClick={onRefresh} title="Refresh Visual Session" type="button">
              <RotateCcw aria-hidden="true" size={16} />
              <span className="sr-only">Refresh Visual Session</span>
            </button>
          </div>
        </div>

        <div className="annotation-compose">
          <label htmlFor="feedback-target">Component</label>
          <select
            disabled={readOnly || components.length === 0}
            id="feedback-target"
            onChange={event => setTargetId(event.target.value)}
            value={effectiveTargetId}
          >
            {components.map(component => <option key={component.id} value={component.id}>{component.label}</option>)}
          </select>
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

        <div
          aria-label="Pending feedback"
          aria-live="polite"
          aria-relevant="additions text"
          className="pending"
          role="group"
        >
          {draft.annotations.map(annotation => (
            <span className="chip chip-note" data-primitive="chip" key={annotation.id}>
              <span><strong>Note</strong> {annotation.target.label}</span>
              <button
                aria-label={`Remove note: ${annotation.target.label}`}
                disabled={readOnly}
                onClick={() => removeAnnotation(annotation.id)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </span>
          ))}
          {draft.choices.map(choice => (
            <span className="chip chip-choice" data-primitive="chip" key={choice.componentId}>
              <span><strong>Choice</strong> {choice.label}</span>
              <button
                aria-label={`Remove choice: ${choice.label}`}
                disabled={readOnly}
                onClick={() => removeChoice(choice)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </span>
          ))}
        </div>

        <label className="sr-only" htmlFor="summary-note">Summary Note</label>
        <textarea
          disabled={readOnly}
          id="summary-note"
          maxLength={10_000}
          onChange={event => onDraftChange({ ...draft, message: event.target.value })}
          placeholder="Add one summary note…"
          value={draft.message}
        />
        <p className="handoff">
          {readOnly
            ? "Read-only export. Feedback is disabled in this standalone copy."
            : "Submit once after reviewing the full visual."}
        </p>
        {error ? <p className="screen-error" role="alert">{error}</p> : null}
        <button className="primary-button" disabled={!canSubmit} onClick={onSubmit} type="button">
          <Send aria-hidden="true" size={16} />
          {submitting ? "Saving feedback…" : "Save feedback batch"}
        </button>
      </section>

      <section className="history" aria-labelledby="history-heading">
        <h3 id="history-heading">Session history</h3>
        {events.length > 0 ? events.map((event, index) => (
          <article className={`history-item ${event.role ?? "system"}`} key={event.id ?? `${event.seq ?? "event"}-${index}`}>
            <header className="history-head">
              <strong>{eventTitle(event)}</strong>
              {event.timestamp
                ? <time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                : null}
            </header>
            <MessageBody message={historyMessage(event)} />
            {event.annotations?.map(annotation => (
              <p className="history-detail history-note" key={annotation.id}>
                <strong>{annotation.target.label}</strong> <InlineText value={annotation.comment} />
              </p>
            ))}
            {event.choices?.map(choice => (
              <p className="history-detail history-choice" key={`${choice.groupId ?? "choice"}-${choice.componentId}`}>
                <strong>Chose</strong> {choice.label}
              </p>
            ))}
          </article>
        )) : <p className="history-empty">No feedback exchanged yet.</p>}
      </section>
    </aside>
  );
}
