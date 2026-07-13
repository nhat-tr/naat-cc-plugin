import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

import { parseInlineSegments, parseMessageBlocks } from "../app/feedback-store";

interface InlineTextProps {
  copyFileReferences?: boolean;
  value: string;
}

interface FileReferenceProps {
  value: string;
}

function FileReference({ value }: FileReferenceProps) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) return;
      await globalThis.navigator.clipboard.writeText(value);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 900);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      aria-label={`${copied ? "Copied" : "Copy"} file reference ${value}`}
      className="file-ref"
      data-copied={copied || undefined}
      onClick={() => void copy()}
      title="Copy file reference"
      type="button"
    >
      {copied ? <Check aria-hidden="true" size={12} /> : <Copy aria-hidden="true" size={12} />}
      <span>{value}</span>
    </button>
  );
}

export function InlineText({ copyFileReferences = true, value }: InlineTextProps) {
  return parseInlineSegments(value).map((segment, index): ReactNode => {
    const key = `${segment.type}-${index}`;
    if (segment.type === "strong") return <strong key={key}>{segment.value}</strong>;
    if (segment.type === "code") return <code className="inline-code" key={key}>{segment.value}</code>;
    if (segment.type === "fileref") {
      return copyFileReferences
        ? <FileReference key={key} value={segment.value} />
        : <code className="file-ref" key={key}>{segment.value}</code>;
    }
    return <span key={key}>{segment.value}</span>;
  });
}

export function MessageBlocks({ value }: { value: string }) {
  return (
    <div className="message-body">
      {parseMessageBlocks(value).map((block, index) => {
        if (block.type === "paragraph") return <p key={`p-${index}`}><InlineText value={block.text} /></p>;
        const List = block.type === "ordered" ? "ol" : "ul";
        return (
          <List key={`${block.type}-${index}`}>
            {block.items.map((item, itemIndex) => <li key={itemIndex}><InlineText value={item} /></li>)}
          </List>
        );
      })}
    </div>
  );
}
