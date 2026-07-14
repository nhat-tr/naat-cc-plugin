function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

interface ReviewPointOwner {
  component_id?: unknown;
  points?: unknown;
}

export function reviewPointComponentIds(owner: ReviewPointOwner | undefined): string[] {
  const componentId = typeof owner?.component_id === "string" ? owner.component_id : "";
  return componentId ? strings(owner?.points).map((_point, index) => `${componentId}-p${index + 1}`) : [];
}

export function ReviewPoints({ label, owner }: { label: string; owner: ReviewPointOwner }) {
  const componentId = typeof owner.component_id === "string" ? owner.component_id : "";
  const points = strings(owner.points);
  if (!componentId || points.length === 0) return null;
  return (
    <ul className="review-points">
      {points.map((point, index) => (
        <li
          data-brainstorm-id={`${componentId}-p${index + 1}`}
          data-brainstorm-label={`${label} · point ${index + 1}`}
          key={`${componentId}-p${index + 1}`}
        >
          {point}
        </li>
      ))}
    </ul>
  );
}
