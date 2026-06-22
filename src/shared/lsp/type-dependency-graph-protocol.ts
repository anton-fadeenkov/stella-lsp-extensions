import type { AnalysisPosition } from "../analysis/analysis-types.js";
import type { TypeDependencyGraphView } from "../analysis/type-dependency-graph-types.js";

export const STELLA_TYPE_DEPENDENCY_GRAPH_REQUEST =
  "stella/typeDependencyGraph";

export interface TypeDependencyGraphRequestParams {
  uri: string;
  position: AnalysisPosition;
}

export type TypeDependencyGraphRequestResult = TypeDependencyGraphView | null;
