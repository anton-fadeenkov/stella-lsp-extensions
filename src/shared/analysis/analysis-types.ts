export interface AnalysisPosition {
  line: number;
  character: number;
}

export interface AnalysisRange {
  start: AnalysisPosition;
  end: AnalysisPosition;
}

export interface AstViewNode {
  id: string;
  type: string;
  label: string;
  edgeLabel?: string;
  property?: string;
  index?: number;
  range?: AnalysisRange;
  truncated?: boolean;
  children: AstViewNode[];
}

export interface AstViewModel {
  documentUri?: string;
  root: AstViewNode;
}