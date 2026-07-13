import {
  LayoutDashboard,
  ListChecks,
  Monitor,
  MousePointer2,
  Smartphone,
  type LucideIcon,
} from "lucide-react";

export interface PrototypeRegion {
  id: string;
  label: string;
  role: "navigation" | "main" | "complementary";
  items: string[];
}

export interface PrototypeState {
  id: "default" | "loading" | "empty" | "error";
  label: string;
  detail: string;
}

export interface ResponsiveState {
  viewport: "mobile" | "desktop";
  behavior: string;
}

export interface ProductConcept {
  id: string;
  slot: "A" | "B" | "C";
  title: string;
  strategy: {
    id: string;
    difference_kind: "information_architecture" | "interaction_model";
    summary: string;
  };
  preview: {
    primary_action: string;
    regions: PrototypeRegion[];
  };
  focus: {
    states: PrototypeState[];
    responsive: ResponsiveState[];
    accessibility: {
      landmarks: string[];
      keyboard_order: string[];
      announcements: string[];
      reduced_motion: string;
    };
    handoff: {
      component_boundaries: string[];
      data_contracts: string[];
      events: string[];
      implementation_notes: string[];
    };
  };
}

interface PrototypeFrameProps {
  concept: ProductConcept;
  device?: "desktop" | "mobile";
  stateLabel?: string;
}

const strategyIcons: Record<string, LucideIcon> = {
  "command-center": LayoutDashboard,
  "guided-review": ListChecks,
  "direct-manipulation": MousePointer2,
};

function itemLabel(value: string): string {
  return value
    .split("-")
    .map(part => part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part)
    .join(" ");
}

export function PrototypeFrame({ concept, device = "desktop", stateLabel = "Default" }: PrototypeFrameProps) {
  const StrategyIcon = strategyIcons[concept.strategy.id] ?? LayoutDashboard;
  const DeviceIcon = device === "mobile" ? Smartphone : Monitor;

  return (
    <div
      className={`product-prototype product-prototype-${concept.slot.toLowerCase()}`}
      data-device={device}
      data-product-prototype-frame=""
    >
      <header className="product-prototype-bar">
        <span className="product-prototype-device">
          <DeviceIcon aria-hidden="true" size={14} />
          <span>{device === "mobile" ? "Mobile" : "Desktop"}</span>
        </span>
        <span className="product-prototype-state">{stateLabel}</span>
      </header>
      <div className="product-prototype-surface" data-strategy={concept.strategy.id}>
        <div className="product-prototype-titlebar">
          <StrategyIcon aria-hidden="true" size={16} />
          <strong>{concept.strategy.id.split("-").map(itemLabel).join(" ")}</strong>
        </div>
        <div className="product-prototype-regions">
          {concept.preview.regions.map(region => (
            <section
              aria-label={region.label}
              className="product-prototype-region"
              data-region-role={region.role}
              key={region.id}
            >
              <h4>{region.label}</h4>
              <ul>
                {region.items.map(item => <li key={item}>{itemLabel(item)}</li>)}
              </ul>
            </section>
          ))}
        </div>
        <div className="product-prototype-action">
          <span>{concept.preview.primary_action}</span>
        </div>
      </div>
    </div>
  );
}
