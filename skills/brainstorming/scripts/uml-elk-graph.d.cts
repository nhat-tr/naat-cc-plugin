declare const umlElkGraph: {
  readonly UML_NODE_WIDTH: 168;
  readonly UML_NODE_BASE_HEIGHT: 56;
  readonly UML_GRAPH_ROOT_ID: "uml:root";
  readonly UML_STEREOTYPE_KINDS: readonly import("../ui/workspaces/uml/uml-layout").UmlNodeKind[];
  umlCardHeight(
    node: import("../ui/workspaces/uml/uml-layout").UmlGraphNode,
  ): number;
  umlEdgeLabelId(edgeId: string): string;
  umlEdgeLabelLines(label: string | undefined): string[];
  umlEdgeLabelSize(label: string | undefined): {
    width: number;
    height: number;
    lines: string[];
  };
  umlNodeSize(
    node: import("../ui/workspaces/uml/uml-layout").UmlGraphNode,
    direction: "RIGHT" | "DOWN",
  ): { width: number; height: number };
  buildUmlElkGraph(
    content: import("../ui/workspaces/uml/uml-layout").UmlGraphContent,
  ): import("elkjs/lib/elk-api.js").ElkNode;
};

export = umlElkGraph;
