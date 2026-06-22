import type { AnalysisRange } from "./analysis-types.js";

export type TypeDependencyGraphNodeKind =
  | "selected"
  | "expression"
  | "function"
  | "parameter"
  | "binding"
  | "case";

export interface TypeDependencyGraphNode {
  id: string;
  label: string;
  kind: TypeDependencyGraphNodeKind;
  layer: number;
  typeLabel?: string;
  detail?: string;
  range?: AnalysisRange;
  isFocused?: boolean;
  isConflict?: boolean;
}

export interface TypeDependencyGraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: string;
  isConflict?: boolean;
}

export interface TypeDependencyGraphView {
  documentUri?: string;
  title: string;
  summary?: string;
  rootNodeId: string;
  nodes: TypeDependencyGraphNode[];
  edges: TypeDependencyGraphEdge[];
}
