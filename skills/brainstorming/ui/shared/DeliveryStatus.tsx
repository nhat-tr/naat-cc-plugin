import { CheckCircle2, CircleOff, Clock3, Radio, RefreshCw, Send } from "lucide-react";

import type { BrowserDeliveryState } from "../app/session-client";

interface DeliveryStatusProps {
  readOnly: boolean;
  state: BrowserDeliveryState;
}

const LABELS: Record<BrowserDeliveryState, string> = {
  listening: "Listening",
  queued: "Queued",
  delivered: "Delivered",
  acknowledged: "Acknowledged",
  reconnecting: "Reconnecting",
  closed: "Closed",
};

function StatusIcon({ state }: { state: BrowserDeliveryState }) {
  const properties = { "aria-hidden": true, size: 14 } as const;
  if (state === "listening") return <Radio {...properties} />;
  if (state === "queued") return <Clock3 {...properties} />;
  if (state === "delivered") return <Send {...properties} />;
  if (state === "acknowledged") return <CheckCircle2 {...properties} />;
  if (state === "reconnecting") return <RefreshCw {...properties} />;
  return <CircleOff {...properties} />;
}

export function DeliveryStatus({ readOnly, state }: DeliveryStatusProps) {
  const label = readOnly ? "Offline export" : LABELS[state];
  return (
    <span
      aria-label={`Feedback delivery: ${label}`}
      aria-live="polite"
      className="delivery-status"
      data-delivery-state={readOnly ? "closed" : state}
      role="status"
    >
      <StatusIcon state={readOnly ? "closed" : state} />
      <span>{label}</span>
    </span>
  );
}
