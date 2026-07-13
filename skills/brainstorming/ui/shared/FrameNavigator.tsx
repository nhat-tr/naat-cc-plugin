import { useRef, type KeyboardEvent } from "react";

export interface WorkspaceFrame {
  id: string;
  title: string;
  component_ids: string[];
}

interface FrameNavigatorProps {
  frames: WorkspaceFrame[];
  activeFrameId: string;
  onSelect: (frameId: string) => void;
}

export function FrameNavigator({ frames, activeFrameId, onSelect }: FrameNavigatorProps) {
  const tabs = useRef(new Map<string, HTMLButtonElement>());

  const selectAt = (index: number): void => {
    const frame = frames[index];
    if (!frame) return;
    onSelect(frame.id);
    tabs.current.get(frame.id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % frames.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + frames.length) % frames.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = frames.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    selectAt(nextIndex);
  };

  return (
    <nav className="frame-nav" aria-label="Workspace frames" role="tablist">
      {frames.map((frame, index) => {
        const selected = frame.id === activeFrameId;
        return (
          <button
            aria-controls={`frame-panel-${frame.id}`}
            aria-selected={selected}
            className="frame-tab"
            id={`frame-tab-${frame.id}`}
            key={frame.id}
            onClick={() => onSelect(frame.id)}
            onKeyDown={event => onKeyDown(event, index)}
            ref={element => {
              if (element) tabs.current.set(frame.id, element);
              else tabs.current.delete(frame.id);
            }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {frame.title}
          </button>
        );
      })}
    </nav>
  );
}
