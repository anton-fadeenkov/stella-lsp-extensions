import type { AnalysisRange } from "./analysis-types.js";

export interface TypeDerivationNode {
  id: string;
  ruleName: string;
  conclusion: string;
  premises: TypeDerivationNode[];
  range?: AnalysisRange;
  expressionText?: string;
  typeText?: string;
  contextText?: string;
}

export interface TypeDerivationView {
  documentUri?: string;
  root: TypeDerivationNode;
}
