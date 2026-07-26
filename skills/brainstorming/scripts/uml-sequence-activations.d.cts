declare const umlSequenceActivations: {
  deriveSequenceActivations(
    messages: readonly import("../ui/workspaces/uml/uml-layout").UmlMessage[] | undefined,
  ): {
    lifelineId: string;
    messageId: string;
    componentId: string;
    label: string;
    openRow: number;
    closeRow: number;
    depth: number;
    terminator: "reply" | "self-return" | "open-ended";
  }[];
};

export = umlSequenceActivations;
