import { createElement, type ReactNode } from "react";

import { ArchitectureCanvas } from "../workspaces/architecture/ArchitectureCanvas";
import { BusinessReasoningCanvas } from "../workspaces/business/BusinessReasoningCanvas";
import { ProductConceptStudio } from "../workspaces/product/ProductConceptStudio";
import { ResearchEvidenceBoard } from "../workspaces/research/ResearchEvidenceBoard";
import { FeatureReviewWorkbench } from "../workspaces/review/FeatureReviewWorkbench";
import type { WorkspaceEnvelope } from "./WorkspaceHost";
import type { Choice } from "./feedback-store";

export type WorkspaceKind = WorkspaceEnvelope["workspace_kind"];

export interface WorkspaceCompositionContext {
  activeFrameId: string;
  choices: Choice[];
  documentValue: WorkspaceEnvelope;
  onChoice: (choice: Choice, selected: boolean, multiselect: boolean) => void;
  onFrameSelect: (frameId: string) => void;
  readOnly: boolean;
}

type WorkspaceComposition = (context: WorkspaceCompositionContext) => ReactNode;

export const workspaceCompositionMap = {
  product: context => createElement(ProductConceptStudio, {
    activeFrameId: context.activeFrameId,
    choices: context.choices,
    content: context.documentValue.content,
    decisions: context.documentValue.decisions,
    onChoice: context.onChoice,
    onFrameSelect: context.onFrameSelect,
    readOnly: context.readOnly,
  }),
  architecture: context => createElement(ArchitectureCanvas, {
    content: context.documentValue.content,
  }),
  research: context => createElement(ResearchEvidenceBoard, {
    components: context.documentValue.components,
    content: context.documentValue.content,
    evidenceRefs: context.documentValue.evidence_refs,
  }),
  business: context => createElement(BusinessReasoningCanvas, {
    components: context.documentValue.components,
    content: context.documentValue.content,
    evidenceRefs: context.documentValue.evidence_refs,
  }),
  review: context => createElement(FeatureReviewWorkbench, {
    content: context.documentValue.content,
  }),
} satisfies Record<WorkspaceKind, WorkspaceComposition>;
