export type DeliveryConnection = "open" | "reconnecting" | "closed";
export type BrowserDeliveryState = "listening" | "queued" | "delivered" | "acknowledged" | "reconnecting" | "closed";

export interface DeliveryEvidence {
  connection: DeliveryConnection;
  listening: boolean;
  durableSeq: number | null;
  deliveredThrough: number;
  acknowledgedThrough: number;
}

export interface VisualSessionState {
  screen: unknown;
  session: unknown;
  deliveryEvidence: DeliveryEvidence;
}

interface SessionEventHandlers {
  onConnection: (connection: DeliveryConnection) => void;
  onReconcile: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function normalizeDeliveryEvidence(value: unknown): DeliveryEvidence {
  if (!isRecord(value)) throw new TypeError("deliveryEvidence must be an object");
  if (value.connection !== "open" && value.connection !== "reconnecting" && value.connection !== "closed") {
    throw new TypeError("deliveryEvidence.connection is invalid");
  }
  if (typeof value.listening !== "boolean") throw new TypeError("deliveryEvidence.listening must be boolean");
  const durableSeq = value.durableSeq === null
    ? null
    : nonNegativeInteger(value.durableSeq, "deliveryEvidence.durableSeq");
  return {
    connection: value.connection,
    listening: value.listening,
    durableSeq,
    deliveredThrough: nonNegativeInteger(value.deliveredThrough, "deliveryEvidence.deliveredThrough"),
    acknowledgedThrough: nonNegativeInteger(value.acknowledgedThrough, "deliveryEvidence.acknowledgedThrough"),
  };
}

export function deriveBrowserDeliveryState(evidence: DeliveryEvidence): BrowserDeliveryState {
  if (evidence.connection === "closed") return "closed";
  if (evidence.connection === "reconnecting") return "reconnecting";
  if (evidence.durableSeq !== null) {
    if (evidence.acknowledgedThrough >= evidence.durableSeq) return "acknowledged";
    if (evidence.deliveredThrough >= evidence.durableSeq) return "delivered";
    return "queued";
  }
  return evidence.listening ? "listening" : "closed";
}

export async function loadVisualSessionState(basePath: string): Promise<VisualSessionState> {
  const response = await fetch(`${basePath}api/state`);
  if (!response.ok) {
    let message = `Visual Session state request failed: ${response.status}`;
    try {
      const body = await response.json() as unknown;
      if (isRecord(body) && typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Keep the status-based message when an error response is not JSON.
    }
    throw new Error(message);
  }
  const value = await response.json() as unknown;
  if (!isRecord(value) || !("screen" in value) || !("session" in value)) {
    throw new TypeError("Visual Session state response is invalid");
  }
  return {
    screen: value.screen,
    session: value.session,
    deliveryEvidence: normalizeDeliveryEvidence(value.deliveryEvidence),
  };
}

export function connectVisualSessionEvents(basePath: string, handlers: SessionEventHandlers): () => void {
  const source = new EventSource(`${basePath}api/events`);
  const reconcile = (): void => handlers.onReconcile();
  source.addEventListener("open", () => handlers.onConnection("open"));
  source.addEventListener("resync", reconcile);
  source.addEventListener("screen", reconcile);
  source.addEventListener("session", reconcile);
  source.addEventListener("delivery", reconcile);
  source.addEventListener("closed", () => {
    handlers.onConnection("closed");
    source.close();
  });
  source.addEventListener("error", () => {
    handlers.onConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
  });
  return () => source.close();
}
