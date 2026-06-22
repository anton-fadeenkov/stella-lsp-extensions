import type { AnalysisRange } from "./analysis-types.js";

export interface ScopeBindingView {
  id: string;
  name: string;
  kind: string;
  typeLabel: string;
  sourceNodeId: string;
  sourceLabel: string;
  range?: AnalysisRange;
}

export interface ScopeFrameView {
  id: string;
  label: string;
  bindings: ScopeBindingView[];
}

export interface ScopeSnapshotView {
  documentUri?: string;
  activeNodeId: string;
  activeNodeLabel: string;
  activeNodeType?: string;
  activeRange?: AnalysisRange;
  frames: ScopeFrameView[];
}
