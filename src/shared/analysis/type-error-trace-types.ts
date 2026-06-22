import type { AnalysisRange } from "./analysis-types.js";

export interface TypeErrorTraceDiagnosticView {
  message: string;
  range?: AnalysisRange;
  expectedType?: string;
  actualType?: string;
}

export interface TypeErrorTraceNode {
  id: string;
  ruleName: string;
  judgement: string;
  detail?: string;
  range?: AnalysisRange;
  isFocused?: boolean;
  isErrorSource?: boolean;
  children: TypeErrorTraceNode[];
}

export interface TypeErrorTraceView {
  documentUri?: string;
  diagnostic: TypeErrorTraceDiagnosticView;
  root: TypeErrorTraceNode;
}
