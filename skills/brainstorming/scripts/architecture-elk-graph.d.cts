declare const architectureElkGraph: {
  readonly ARCHITECTURE_NODE_HEIGHT: 68;
  readonly ARCHITECTURE_NODE_WIDTH: 156;
  architectureScenarioPresentation(
    content: import("../ui/workspaces/architecture/architecture-layout").ArchitectureWorkspaceContent,
    mode: import("../ui/workspaces/architecture/architecture-layout").ArchitectureMode,
    scenario: import("../ui/workspaces/architecture/architecture-layout").ArchitectureScenario | null,
  ): {
    content: import("../ui/workspaces/architecture/architecture-layout").ArchitectureWorkspaceContent;
    edgeIds: Set<string>;
    nodeIds: Set<string>;
  };
  architectureNodeHeight(
    node: import("../ui/workspaces/architecture/architecture-layout").ArchitectureNode,
  ): number;
  buildArchitectureElkGraph(
    content: import("../ui/workspaces/architecture/architecture-layout").ArchitectureWorkspaceContent,
  ): import("elkjs/lib/elk-api.js").ElkNode;
  defaultArchitecturePresentationScope(
    content: import("../ui/workspaces/architecture/architecture-layout").ArchitectureWorkspaceContent,
  ): "all" | "scenario";
};

export = architectureElkGraph;
