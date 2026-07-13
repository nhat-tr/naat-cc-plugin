export type FeedbackThreadStatus = "open" | "resolved" | "outdated";

export interface ChangeFlags {
  added: string[];
  updated: string[];
  removed: Array<{ id: string; label: string }>;
}

export interface FeedbackReply {
  id: string;
  author: string;
  text: string;
  recorded_at: string;
}

export interface FeedbackThread {
  id: string;
  component_id: string;
  revision: string;
  type: string;
  status: FeedbackThreadStatus;
  comment: string;
  replies: FeedbackReply[];
}

export interface AnnotationTarget {
  componentId: string;
  label: string;
  selector?: string | null;
}

export interface Annotation {
  id: string;
  comment: string;
  target: AnnotationTarget;
}

export interface Choice {
  groupId?: string | null;
  componentId: string;
  value: string;
  label: string;
}

export interface FeedbackDraft {
  annotations: Annotation[];
  choices: Choice[];
  message: string;
  clientTurnId: string | null;
}

export interface SessionEvent {
  id?: string;
  seq?: number;
  timestamp?: number;
  type?: string;
  role?: string;
  message?: string;
  annotations?: Annotation[];
  choices?: Choice[];
}

export interface SessionSnapshot {
  version?: number;
  cursor?: number;
  pendingTurns?: number;
  events: SessionEvent[];
}

interface LegacyComponentEntry {
  fingerprint: string;
  label: string;
  parent: string | null;
}

interface ResponseWithJson {
  json(): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).filter(isRecord);
}

function legacyDocument(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (value.version === 1) return value;
  if (value.version !== 2 || !isRecord(value.content)) return null;
  return isRecord(value.content.legacy_document) ? value.content.legacy_document : null;
}

export function reconcileChoices(
  choices: Choice[],
  next: Choice,
  options: { selected: boolean; multiselect: boolean },
): Choice[] {
  const sameOption = (choice: Choice): boolean => choice.componentId === next.componentId;
  if (!options.selected) return choices.filter(choice => !sameOption(choice));
  const updated = next.groupId && !options.multiselect
    ? choices.filter(choice => choice.groupId !== next.groupId)
    : [...choices];
  const existing = updated.findIndex(sameOption);
  if (existing >= 0) updated[existing] = next;
  else updated.push(next);
  return updated;
}

export function isChoiceSelected(choices: Choice[], componentId: string): boolean {
  return choices.some(choice => choice.componentId === componentId);
}

function choiceGroupKey(choice: Choice): string {
  return choice.groupId || `component:${choice.componentId}`;
}

export function deriveCommittedChoices(
  events: SessionEvent[],
  multiselectByGroup: Readonly<Record<string, boolean>> = {},
): Choice[] {
  let committed: Choice[] = [];
  for (const event of events) {
    if (event.type !== "user.turn" || !Array.isArray(event.choices)) continue;
    for (const choice of event.choices) {
      if (!choice || typeof choice.componentId !== "string" || typeof choice.value !== "string") continue;
      const normalized: Choice = {
        groupId: typeof choice.groupId === "string" ? choice.groupId : null,
        componentId: choice.componentId,
        value: choice.value,
        label: typeof choice.label === "string" ? choice.label : choice.value,
      };
      committed = reconcileChoices(committed, normalized, {
        selected: true,
        multiselect: normalized.groupId ? multiselectByGroup[normalized.groupId] === true : false,
      });
    }
  }
  return committed;
}

export function mergeChoiceState(committed: Choice[], draft: Choice[]): Choice[] {
  const draftGroups = new Set(draft.map(choiceGroupKey));
  return [
    ...committed.filter(choice => !draftGroups.has(choiceGroupKey(choice))),
    ...draft,
  ];
}

export function normalizeFeedbackDraft(value: unknown = {}): FeedbackDraft {
  const source = isRecord(value) ? value : {};
  const annotations = recordArray(source.annotations).flatMap(annotation => {
    if (!isRecord(annotation.target)) return [];
    const id = stringField(annotation.id);
    const comment = stringField(annotation.comment);
    const componentId = stringField(annotation.target.componentId);
    const label = stringField(annotation.target.label, componentId);
    if (!id || !comment || !componentId) return [];
    return [{ id, comment, target: { componentId, label } }];
  });
  const choices = recordArray(source.choices).flatMap(choice => {
    const componentId = stringField(choice.componentId);
    const valueField = stringField(choice.value);
    const label = stringField(choice.label, valueField);
    if (!componentId || !valueField) return [];
    return [{
      groupId: typeof choice.groupId === "string" ? choice.groupId : null,
      componentId,
      value: valueField,
      label,
    }];
  });
  return {
    annotations,
    choices,
    message: stringField(source.message),
    clientTurnId: stringField(source.clientTurnId) || null,
  };
}

export function groupAnnotationsByComponent(annotations: Annotation[] = []): Map<string, Annotation[]> {
  const grouped = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    const componentId = annotation?.target?.componentId;
    if (!componentId) continue;
    const current = grouped.get(componentId) ?? [];
    current.push(annotation);
    grouped.set(componentId, current);
  }
  return grouped;
}

export function annotationSummary(annotations: Annotation[] = []): string {
  const count = annotations.length;
  const noun = count === 1 ? "annotation" : "annotations";
  const messages = annotations
    .map((annotation, index) => `${index + 1}. ${annotation.comment.trim()}`)
    .join("\n");
  return `${count} ${noun}:${messages ? `\n${messages}` : ""}`;
}

export async function readResponseError(response: ResponseWithJson, fallback: string): Promise<string> {
  try {
    const value = await response.json();
    return isRecord(value) && typeof value.error === "string" && value.error ? value.error : fallback;
  } catch {
    return fallback;
  }
}

const FILE_REFERENCE_PATTERN = new RegExp(
  "(?<![\\w./-])(?:"
  + "(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\\.[A-Za-z]{1,7}(?::\\d+(?:-\\d+)?)?"
  + "|[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(?:cs|csproj|sln|tsx|jsx|cjs|mjs|jsonl|json|md|ya?ml|toml|css|scss|html|sh|py|go|rs|java|kt|rb|sql|xml|config|props|targets)(?::\\d+(?:-\\d+)?)?"
  + "|[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(?:js|ts):\\d+(?:-\\d+)?"
  + ")(?!\\w)",
  "g",
);

const INLINE_MARKUP_PATTERN = /`([^`]+)`|\*\*((?:[^*]|\*(?!\*))+?)\*\*/gu;

export type InlineSegment = { type: "text" | "fileref" | "code" | "strong"; value: string };

function splitFileReferences(value: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of value.matchAll(FILE_REFERENCE_PATTERN)) {
    const matchIndex = match.index;
    if (matchIndex > last) segments.push({ type: "text", value: value.slice(last, matchIndex) });
    segments.push({ type: "fileref", value: match[0] });
    last = matchIndex + match[0].length;
  }
  if (last < value.length) segments.push({ type: "text", value: value.slice(last) });
  return segments;
}

export function parseInlineSegments(text: unknown): InlineSegment[] {
  const source = String(text ?? "");
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE_MARKUP_PATTERN)) {
    const matchIndex = match.index;
    if (matchIndex > last) segments.push(...splitFileReferences(source.slice(last, matchIndex)));
    if (match[1] != null) segments.push({ type: "code", value: match[1] });
    else segments.push({ type: "strong", value: match[2] ?? "" });
    last = matchIndex + match[0].length;
  }
  if (last < source.length) segments.push(...splitFileReferences(source.slice(last)));
  return segments;
}

export type MessageBlock =
  | { type: "paragraph"; text: string }
  | { type: "ordered" | "bulleted"; items: string[] };

export function parseMessageBlocks(text: unknown): MessageBlock[] {
  const lines = String(text ?? "").replace(/\r\n/gu, "\n").split("\n");
  const blocks: MessageBlock[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const line of lines) {
    const ordered = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/u);
    const bulleted = line.match(/^\s*[-•]\s+(.*)$/u) ?? line.match(/^\s*\*(?!\*)\s+(.*)$/u);
    if (ordered || bulleted) {
      flush();
      const type = ordered ? "ordered" : "bulleted";
      const item = (ordered?.[1] ?? bulleted?.[1] ?? "").trim();
      const lastBlock = blocks.at(-1);
      if (lastBlock?.type === type) lastBlock.items.push(item);
      else blocks.push({ type, items: [item] });
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

function collectLegacyComponents(value: unknown): Map<string, LegacyComponentEntry> {
  const documentValue = legacyDocument(value);
  const map = new Map<string, LegacyComponentEntry>();
  if (!documentValue) return map;
  const add = (id: string, payload: unknown, label: string, parent: string | null): void => {
    map.set(id, { fingerprint: JSON.stringify(payload), label, parent });
  };
  for (const section of recordArray(documentValue.sections)) {
    const id = stringField(section.id);
    const title = stringField(section.title, id);
    const { items, nodes, options, regions, ...sectionOwn } = section;
    add(id, sectionOwn, title, null);
    for (const child of [...recordArray(items), ...recordArray(nodes), ...recordArray(regions)]) {
      const childId = stringField(child.id);
      const childTitle = stringField(child.title, childId);
      const { points, elements, ...childOwn } = child;
      add(childId, childOwn, childTitle, id);
      asArray(points).forEach((point, index) => add(`${childId}-p${index + 1}`, point, `${childTitle} · point ${index + 1}`, childId));
      recordArray(elements).forEach((element, index) => add(
        `${childId}-e${index + 1}`,
        element,
        `${childTitle} · ${stringField(element.kind, "element")} ${index + 1}`,
        childId,
      ));
    }
    for (const option of recordArray(options)) {
      const optionId = stringField(option.id);
      const label = stringField(option.label, optionId);
      const { points, ...optionOwn } = option;
      add(optionId, optionOwn, label, id);
      asArray(points).forEach((point, index) => add(`${optionId}-p${index + 1}`, point, `${label} · point ${index + 1}`, optionId));
    }
  }
  return map;
}

function collectEnvelopeComponents(value: unknown): Map<string, LegacyComponentEntry> {
  const map = new Map<string, LegacyComponentEntry>();
  if (!isRecord(value) || value.version !== 2) return map;
  for (const component of recordArray(value.components)) {
    const id = stringField(component.id);
    const label = stringField(component.label, id);
    if (id) map.set(id, { fingerprint: JSON.stringify(component), label, parent: null });
  }
  return map;
}

export function computeComponentChanges(previousDocument: unknown, nextDocument: unknown): ChangeFlags {
  if (!previousDocument) return { added: [], updated: [], removed: [] };
  const beforeLegacy = legacyDocument(previousDocument);
  const afterLegacy = legacyDocument(nextDocument);
  const before = beforeLegacy && afterLegacy
    ? collectLegacyComponents(previousDocument)
    : collectEnvelopeComponents(previousDocument);
  const after = beforeLegacy && afterLegacy
    ? collectLegacyComponents(nextDocument)
    : collectEnvelopeComponents(nextDocument);
  const addedSet = new Set<string>();
  const added: string[] = [];
  const updated: string[] = [];
  for (const [id, entry] of after) {
    const prior = before.get(id);
    if (!prior) {
      addedSet.add(id);
      if (!entry.parent || !addedSet.has(entry.parent)) added.push(id);
    } else if (prior.fingerprint !== entry.fingerprint) {
      updated.push(id);
    }
  }
  const removedSet = new Set([...before.keys()].filter(id => !after.has(id)));
  const removed = [...removedSet]
    .filter(id => {
      const parent = before.get(id)?.parent;
      return !parent || !removedSet.has(parent);
    })
    .map(id => ({ id, label: before.get(id)?.label ?? id }));
  return { added, updated, removed };
}

export function deriveFeedbackThreadState(
  thread: Pick<FeedbackThread, "component_id" | "revision" | "status">,
  currentRevision: string,
  changes: ChangeFlags,
): FeedbackThreadStatus {
  if (thread.status === "resolved" || thread.status === "outdated") return thread.status;
  if (thread.revision === currentRevision) return "open";
  const changed = changes.updated.includes(thread.component_id)
    || changes.removed.some(component => component.id === thread.component_id);
  return changed ? "outdated" : "open";
}

export function emptySessionSnapshot(): SessionSnapshot {
  return { events: [] };
}

export function createClientTurnId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `feedback-${Date.now()}`;
}
