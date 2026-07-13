import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export type PaneSeparatorOrientation = "horizontal" | "vertical";
export type PaneSeparatorResizeSide = "after" | "before";

export interface PaneSeparatorProps {
  "aria-controls": string;
  className?: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  orientation: PaneSeparatorOrientation;
  resizeSide: PaneSeparatorResizeSide;
  value: number;
  valueText: string;
}

interface PointerResize {
  id: number;
  latestValue: number;
  startPosition: number;
  startValue: number;
}

const KEYBOARD_STEP = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function PaneSeparator({
  "aria-controls": controls,
  className,
  label,
  max,
  min,
  onChange,
  onCommit,
  orientation,
  resizeSide,
  value,
  valueText,
}: PaneSeparatorProps) {
  const lowerBound = Math.min(min, max);
  const upperBound = Math.max(min, max);
  const boundedValue = clamp(value, lowerBound, upperBound);
  const pointerResize = useRef<PointerResize | null>(null);
  const [resizing, setResizing] = useState(false);

  const pointerPosition = (event: PointerEvent<HTMLDivElement>): number => (
    orientation === "vertical" ? event.clientX : event.clientY
  );

  const valueAtPosition = (position: number, resize: PointerResize): number => {
    const physicalDelta = position - resize.startPosition;
    const valueDirection = resizeSide === "before" ? 1 : -1;
    return clamp(resize.startValue + physicalDelta * valueDirection, lowerBound, upperBound);
  };

  const changeValue = (nextValue: number, previousValue: number): number => {
    if (nextValue !== previousValue) onChange(nextValue);
    return nextValue;
  };

  const finishPointerResize = (event: PointerEvent<HTMLDivElement>): void => {
    const resize = pointerResize.current;
    if (!resize || resize.id !== event.pointerId) return;

    resize.latestValue = changeValue(valueAtPosition(pointerPosition(event), resize), resize.latestValue);
    pointerResize.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit(resize.latestValue);
  };

  const moveBy = (physicalDelta: number): void => {
    const valueDirection = resizeSide === "before" ? 1 : -1;
    const nextValue = clamp(boundedValue + physicalDelta * valueDirection, lowerBound, upperBound);
    if (nextValue === boundedValue) return;
    onChange(nextValue);
    onCommit(nextValue);
  };

  const moveTo = (nextValue: number): void => {
    if (nextValue === boundedValue) return;
    onChange(nextValue);
    onCommit(nextValue);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let handled = true;
    if (event.key === "Home") moveTo(lowerBound);
    else if (event.key === "End") moveTo(upperBound);
    else if (orientation === "vertical" && event.key === "ArrowLeft") moveBy(-KEYBOARD_STEP);
    else if (orientation === "vertical" && event.key === "ArrowRight") moveBy(KEYBOARD_STEP);
    else if (orientation === "horizontal" && event.key === "ArrowUp") moveBy(-KEYBOARD_STEP);
    else if (orientation === "horizontal" && event.key === "ArrowDown") moveBy(KEYBOARD_STEP);
    else handled = false;

    if (handled) event.preventDefault();
  };

  return (
    <div
      aria-controls={controls}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemax={upperBound}
      aria-valuemin={lowerBound}
      aria-valuenow={boundedValue}
      aria-valuetext={valueText}
      className={["pane-separator", `pane-separator-${orientation}`, className].filter(Boolean).join(" ")}
      data-resize-side={resizeSide}
      data-resizing={resizing ? "" : undefined}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={event => {
        const resize = pointerResize.current;
        if (!resize || resize.id !== event.pointerId) return;
        pointerResize.current = null;
        setResizing(false);
        onCommit(resize.latestValue);
      }}
      onPointerCancel={finishPointerResize}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || pointerResize.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        pointerResize.current = {
          id: event.pointerId,
          latestValue: boundedValue,
          startPosition: pointerPosition(event),
          startValue: boundedValue,
        };
        setResizing(true);
      }}
      onPointerMove={event => {
        const resize = pointerResize.current;
        if (!resize || resize.id !== event.pointerId) return;
        event.preventDefault();
        resize.latestValue = changeValue(valueAtPosition(pointerPosition(event), resize), resize.latestValue);
      }}
      onPointerUp={finishPointerResize}
      role="separator"
      tabIndex={0}
      title={label}
    />
  );
}
