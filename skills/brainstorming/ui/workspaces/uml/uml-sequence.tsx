import { useEffect, useMemo } from "react";

import {
  computeSequenceLayout,
  SEQUENCE_METRICS,
  type LayoutSequenceMessage,
  type UmlSequenceContent,
} from "./uml-layout";

interface UmlSequenceProps {
  content: UmlSequenceContent;
  onPresentedComponentIdsChange?: (componentIds: string[]) => void;
}

const HEADER_WIDTH = SEQUENCE_METRICS.headerWidth;
const HEADER_HEIGHT = SEQUENCE_METRICS.headerHeight;
const ACTIVATION_WIDTH = SEQUENCE_METRICS.activationWidth;
const STEREOTYPE_KINDS = new Set(["actor", "boundary", "control", "entity", "database"]);

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, first => first.toUpperCase());
}

function messageArrowHead(tip: { x: number; y: number }, dirX: number, filled: boolean, key: string) {
  const headLength = 11;
  const headWidth = 5;
  const baseX = tip.x - dirX * headLength;
  const left = { x: baseX, y: tip.y - headWidth };
  const right = { x: baseX, y: tip.y + headWidth };
  if (filled) {
    return (
      <polygon
        className="uml-seq-arrow uml-seq-arrow-filled"
        key={key}
        points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
      />
    );
  }
  return (
    <path
      className="uml-seq-arrow uml-seq-arrow-open"
      d={`M ${left.x} ${left.y} L ${tip.x} ${tip.y} L ${right.x} ${right.y}`}
      key={key}
    />
  );
}

function SequenceMessage({ message }: { message: LayoutSequenceMessage }) {
  const { message: model, y, fromX, toX, selfMessage } = message;
  const dashed = model.message_kind === "reply" || model.message_kind === "create";
  const filled = model.message_kind === "sync";
  const label = model.message_kind === "reply" ? model.label : model.label;
  return (
    <g
      className={`uml-seq-message uml-seq-message-${model.message_kind}`}
      data-brainstorm-id={model.component_id}
      data-brainstorm-label={model.label}
      data-message-id={model.id}
      data-message-kind={model.message_kind}
    >
      {selfMessage ? (
        <>
          <path
            className="uml-seq-line"
            d={`M ${fromX} ${y} L ${fromX + 42} ${y} L ${fromX + 42} ${y + SEQUENCE_METRICS.selfLoop} L ${fromX} ${y + SEQUENCE_METRICS.selfLoop}`}
            data-dashed={dashed ? "" : undefined}
            fill="none"
          />
          {messageArrowHead({ x: fromX, y: y + SEQUENCE_METRICS.selfLoop }, -1, filled, `${model.id}-head`)}
          <text className="uml-seq-message-label" textAnchor="start" x={fromX + 50} y={y - 6}>{label}</text>
        </>
      ) : (
        <>
          <line
            className="uml-seq-line"
            data-dashed={dashed ? "" : undefined}
            x1={fromX}
            x2={toX}
            y1={y}
            y2={y}
          />
          {messageArrowHead({ x: toX, y }, toX >= fromX ? 1 : -1, filled, `${model.id}-head`)}
          <text className="uml-seq-message-label" textAnchor="middle" x={(fromX + toX) / 2} y={y - 8}>{label}</text>
        </>
      )}
      {message.points.map(point => (
        <g
          className="uml-seq-point"
          data-brainstorm-id={point.id}
          data-brainstorm-label={point.label}
          key={point.id}
        >
          <text textAnchor="start" x={Math.min(fromX, toX) + 8} y={point.y}>• {point.text}</text>
        </g>
      ))}
    </g>
  );
}

export function UmlSequence({ content, onPresentedComponentIdsChange }: UmlSequenceProps) {
  const layout = useMemo(() => computeSequenceLayout(content), [content]);

  const presentedComponentIds = useMemo(() => {
    const annotationTargets = new Set(content.annotation_targets);
    const ids = [
      ...layout.lifelines.flatMap(item => [item.lifeline.component_id, ...item.points.map(point => point.id)]),
      ...layout.messages.flatMap(item => [item.message.component_id, ...item.points.map(point => point.id)]),
      ...layout.fragments.map(item => item.fragment.component_id),
    ];
    return [...new Set(ids.filter(id => annotationTargets.has(id)))].sort();
  }, [content.annotation_targets, layout]);

  useEffect(() => {
    onPresentedComponentIdsChange?.(presentedComponentIds);
  }, [onPresentedComponentIdsChange, presentedComponentIds]);

  return (
    <section
      className="uml-sequence"
      data-layout-status="ready"
      data-uml-sequence=""
    >
      <div className="uml-sequence-scroll">
        <svg
          aria-label="UML sequence diagram"
          className="uml-sequence-canvas"
          height={layout.height}
          role="img"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
        >
          {layout.fragments.map(item => (
            <g
              className={`uml-seq-fragment uml-seq-fragment-${item.fragment.fragment_kind}`}
              data-brainstorm-id={item.fragment.component_id}
              data-brainstorm-label={item.fragment.label}
              data-fragment-id={item.fragment.id}
              key={item.fragment.id}
            >
              <rect className="uml-seq-fragment-box" height={item.height} rx={4} width={item.width} x={item.x} y={item.y} />
              <path
                className="uml-seq-fragment-tab"
                d={`M ${item.x} ${item.y} h 54 l -8 16 h -46 z`}
              />
              <text className="uml-seq-fragment-kind" x={item.x + 8} y={item.y + 12}>{item.fragment.fragment_kind}</text>
              <text className="uml-seq-fragment-label" x={item.x + 60} y={item.y + 12}>{item.fragment.label}</text>
            </g>
          ))}

          {layout.activations.map((activation, index) => (
            <rect
              className="uml-seq-activation"
              height={Math.max(8, activation.bottom - activation.top)}
              key={`${activation.lifelineId}-${index}`}
              width={ACTIVATION_WIDTH}
              x={activation.centerX - ACTIVATION_WIDTH / 2 + activation.depth * 5}
              y={activation.top}
            />
          ))}

          {layout.lifelines.map(item => (
            <g
              className={`uml-seq-lifeline uml-seq-lifeline-${item.lifeline.lifeline_kind}`}
              data-brainstorm-id={item.lifeline.component_id}
              data-brainstorm-label={item.lifeline.label}
              data-lifeline-id={item.lifeline.id}
              data-lifeline-kind={item.lifeline.lifeline_kind}
              key={item.lifeline.id}
            >
              <line
                className="uml-seq-lifeline-line"
                x1={item.centerX}
                x2={item.centerX}
                y1={item.lineTop}
                y2={item.lineBottom}
              />
              <rect
                className="uml-seq-lifeline-head"
                height={HEADER_HEIGHT}
                rx={5}
                width={HEADER_WIDTH}
                x={item.centerX - HEADER_WIDTH / 2}
                y={item.headerTop}
              />
              {STEREOTYPE_KINDS.has(item.lifeline.lifeline_kind) ? (
                <text className="uml-seq-lifeline-stereotype" textAnchor="middle" x={item.centerX} y={item.headerTop + 16}>
                  «{item.lifeline.lifeline_kind}»
                </text>
              ) : null}
              <text
                className="uml-seq-lifeline-label"
                textAnchor="middle"
                x={item.centerX}
                y={item.headerTop + (STEREOTYPE_KINDS.has(item.lifeline.lifeline_kind) ? 34 : 28)}
              >
                {item.lifeline.label}
              </text>
              {item.points.map(point => (
                <g
                  className="uml-seq-point"
                  data-brainstorm-id={point.id}
                  data-brainstorm-label={point.label}
                  key={point.id}
                >
                  <text textAnchor="middle" x={item.centerX} y={point.y}>• {point.text}</text>
                </g>
              ))}
            </g>
          ))}

          {layout.messages.map(item => <SequenceMessage key={item.message.id} message={item} />)}
        </svg>
      </div>
    </section>
  );
}
