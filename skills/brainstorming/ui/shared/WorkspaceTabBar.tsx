import { useRef, type KeyboardEvent } from "react";

import type { WorkspaceTabMeta } from "../app/session-client";

interface WorkspaceTabBarProps {
  tabs: WorkspaceTabMeta[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
}

export function WorkspaceTabBar({ tabs, activeTabId, onSelect }: WorkspaceTabBarProps) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const selectAt = (index: number): void => {
    const tab = tabs[index];
    if (!tab) return;
    onSelect(tab.id);
    tabRefs.current.get(tab.id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    selectAt(nextIndex);
  };

  return (
    <nav aria-label="Workspace tabs" className="workspace-tab-bar" role="tablist">
      {tabs.map((tab, index) => {
        const selected = tab.id === activeTabId;
        return (
          <button
            aria-controls="workspace-canvas"
            aria-selected={selected}
            className="workspace-tab"
            id={`workspace-tab-${tab.id}`}
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            onKeyDown={event => onKeyDown(event, index)}
            ref={element => {
              if (element) tabRefs.current.set(tab.id, element);
              else tabRefs.current.delete(tab.id);
            }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
