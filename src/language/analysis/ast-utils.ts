import { AstNode } from "langium";
import type {
  AnalysisRange,
  AstViewModel,
  AstViewNode,
} from "../../shared/analysis/analysis-types.js";

export type AstChildEntry = {
  label: string;
  property: string;
  index?: number;
  node: AstNode;
};

type RelationInfo = {
  edgeLabel?: string;
  property?: string;
  index?: number;
};

const PREFERRED_SUMMARY_KEYS = [
  "name",
  "text",
  "value",
  "id",
  "identifier",
  "operator",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function astNodeToRecord(node: AstNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

function isPrimitiveValue(
  value: unknown
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function isAstNodeValue(value: unknown): value is AstNode {
  return isRecord(value) && "$type" in value;
}

function normalizeText(text: string, maxLength = 30): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatSummaryValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return normalizeText(value);
  }
  return String(value);
}

export function collectAstChildren(node: AstNode): AstChildEntry[] {
  const children: AstChildEntry[] = [];

  for (const [name, value] of Object.entries(astNodeToRecord(node))) {
    if (name.startsWith("$") || value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (isAstNodeValue(entry)) {
          children.push({
            label: `${name}[${index}]`,
            property: name,
            index,
            node: entry,
          });
        }
      });
      continue;
    }

    if (isAstNodeValue(value)) {
      children.push({
        label: name,
        property: name,
        node: value,
      });
    }
  }

  return children;
}

export function getAstNodeSummary(node: AstNode): string | undefined {
  const nodeRecord = astNodeToRecord(node);

  for (const key of PREFERRED_SUMMARY_KEYS) {
    const value = nodeRecord[key];
    if (isPrimitiveValue(value)) {
      return `${key}=${formatSummaryValue(value)}`;
    }
  }

  for (const [name, value] of Object.entries(nodeRecord)) {
    if (
      name.startsWith("$") ||
      value === undefined ||
      value === null ||
      Array.isArray(value) ||
      isAstNodeValue(value)
    ) {
      continue;
    }

    if (isPrimitiveValue(value)) {
      return `${name}=${formatSummaryValue(value)}`;
    }
  }

  return undefined;
}

export function getAstNodeLabel(node: AstNode): string {
  const summary = getAstNodeSummary(node);
  return summary ? `${node.$type} (${summary})` : node.$type;
}

export function getAstNodeRange(node: AstNode): AnalysisRange | undefined {
  const range = node.$cstNode?.range;
  if (!range) {
    return undefined;
  }

  return {
    start: {
      line: range.start.line,
      character: range.start.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  };
}

export function buildAstNodeId(node: AstNode): string {
  const segments: string[] = [];
  let current: AstNode | undefined = node;

  while (current) {
    if (!current.$container) {
      segments.unshift(`root:${current.$type}`);
    } else {
      const property = current.$containerProperty ?? "child";
      const indexSuffix =
        typeof current.$containerIndex === "number"
          ? `[${current.$containerIndex}]`
          : "";
      segments.unshift(`${property}${indexSuffix}:${current.$type}`);
    }

    current = current.$container;
  }

  return segments.join("/");
}

function serializeAstNodeInternal(
  node: AstNode,
  maxDepth: number,
  relation?: RelationInfo
): AstViewNode {
  const childEntries = collectAstChildren(node);
  const stopHere = maxDepth <= 0;

  return {
    id: buildAstNodeId(node),
    type: node.$type,
    label: getAstNodeLabel(node),
    edgeLabel: relation?.edgeLabel,
    property: relation?.property,
    index: relation?.index,
    range: getAstNodeRange(node),
    truncated: stopHere && childEntries.length > 0 ? true : undefined,
    children: stopHere
      ? []
      : childEntries.map((child) =>
          serializeAstNodeInternal(child.node, maxDepth - 1, {
            edgeLabel: child.label,
            property: child.property,
            index: child.index,
          })
        ),
  };
}

export function serializeAstNode(
  node: AstNode,
  maxDepth = Number.POSITIVE_INFINITY
): AstViewNode {
  return serializeAstNodeInternal(node, maxDepth);
}

export function serializeAstTree(
  root: AstNode,
  documentUri?: string,
  maxDepth = Number.POSITIVE_INFINITY
): AstViewModel {
  return {
    documentUri,
    root: serializeAstNode(root, maxDepth),
  };
}

export function formatAstNodeTree(node: AstNode, maxDepth = 2): string {
  const lines: string[] = [];

  const visit = (
    current: AstNode,
    depth: number,
    prefix: string,
    edgeLabel?: string,
    isLast = true
  ): void => {
    const currentLabel = getAstNodeLabel(current);
    const lineLabel = edgeLabel
      ? `${edgeLabel}: ${currentLabel}`
      : currentLabel;

    if (depth === 0) {
      lines.push(lineLabel);
    } else {
      const connector = isLast ? "\\- " : "|- ";
      lines.push(`${prefix}${connector}${lineLabel}`);
    }

    const children = collectAstChildren(current);
    if (depth >= maxDepth) {
      if (children.length > 0) {
        const lastIndex = lines.length - 1;
        lines[lastIndex] = `${lines[lastIndex]} ...`;
      }
      return;
    }

    const childPrefix =
      depth === 0 ? "" : `${prefix}${isLast ? "   " : "|  "}`;

    children.forEach((child, index) => {
      const childIsLast = index === children.length - 1;
      const nextPrefix = depth === 0 ? "" : childPrefix;

      visit(child.node, depth + 1, nextPrefix, child.label, childIsLast);
    });
  };

  visit(node, 0, "", undefined, true);
  return lines.join("\n");
}