import { Check, Eye, Scale } from "lucide-react";

import { isChoiceSelected, type Choice } from "../../app/feedback-store";
import { PrototypeFrame, type ProductConcept } from "./PrototypeFrame";

export interface DifferenceDimension {
  id: string;
  label: string;
  values: Record<string, string>;
}

interface ConceptWallProps {
  choices: Choice[];
  concepts: ProductConcept[];
  decisionId: string;
  differenceLens: {
    title: string;
    dimensions: DifferenceDimension[];
  };
  layout: "desktop-stacked" | "mobile-three-up";
  onChoice: (choice: Choice, selected: boolean, multiselect: boolean) => void;
  onInspect: (concept: ProductConcept, origin: HTMLButtonElement) => void;
  readOnly: boolean;
}

export function ConceptWall({
  choices,
  concepts,
  decisionId,
  differenceLens,
  layout,
  onChoice,
  onInspect,
  readOnly,
}: ConceptWallProps) {
  return (
    <div className="product-compare" data-layout={layout}>
      <h2 className="sr-only">Compare product concepts</h2>
      <div className="product-equal-fixture" data-product-equal-fixture="">
        <Scale aria-hidden="true" size={16} />
        <strong>Equal fixture</strong>
        <span>Same device, scope, fidelity, and data</span>
      </div>

      <div className="product-concept-wall" data-layout={layout} data-product-concept-wall="">
        {concepts.map(concept => (
          <article
            className="product-concept"
            data-brainstorm-id={concept.id}
            data-brainstorm-label={concept.title}
            data-concept-id={concept.id}
            data-product-concept=""
            key={concept.id}
          >
            <header className="product-concept-heading">
              <span className="product-concept-slot" aria-hidden="true">{concept.slot}</span>
              <div>
                <h3>
                  <span className="product-concept-title-long">{concept.title}</span>
                  <span className="product-concept-title-short" aria-hidden="true">Concept {concept.slot}</span>
                </h3>
                <p>{concept.strategy.summary}</p>
              </div>
            </header>
            <PrototypeFrame concept={concept} />
            <button
              aria-label={`Inspect ${concept.title}`}
              className="product-inspect-button"
              onClick={event => onInspect(concept, event.currentTarget)}
              type="button"
            >
              <Eye aria-hidden="true" size={16} />
              <span>Inspect</span>
            </button>
          </article>
        ))}
      </div>

      <section
        className="product-difference-lens"
        data-brainstorm-id="difference-lens"
        data-brainstorm-label={differenceLens.title}
        data-product-difference-lens=""
      >
        <header>
          <h3>{differenceLens.title}</h3>
          <p>Compare interaction and information structure without changing the fixture.</p>
        </header>
        <div className="product-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Difference</th>
                {concepts.map(concept => <th key={concept.id} scope="col">{concept.slot}</th>)}
              </tr>
            </thead>
            <tbody>
              {differenceLens.dimensions.map(dimension => (
                <tr key={dimension.id}>
                  <th scope="row">{dimension.label}</th>
                  {concepts.map(concept => <td key={concept.id}>{dimension.values[concept.id]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Choose one product concept" className="product-choice-group" data-product-choice-group="">
        <h3>Choose a direction</h3>
        <div className="product-choice-options">
          {concepts.map(concept => {
            const selected = isChoiceSelected(choices, concept.id);
            return (
              <button
                aria-label={`Select ${concept.title}`}
                aria-pressed={selected}
                className="product-choice-button"
                data-choice-component-id={concept.id}
                disabled={readOnly}
                key={concept.id}
                onClick={() => onChoice({
                  groupId: decisionId,
                  componentId: concept.id,
                  value: concept.id,
                  label: concept.title,
                }, !selected, false)}
                type="button"
              >
                <span className="product-choice-mark" aria-hidden="true">
                  {selected ? <Check size={14} /> : concept.slot}
                </span>
                <span>{concept.title}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
