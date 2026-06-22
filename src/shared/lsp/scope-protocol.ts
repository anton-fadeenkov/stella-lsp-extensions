import type { AnalysisPosition } from "../analysis/analysis-types.js";
import type { ScopeSnapshotView } from "../analysis/scope-types.js";

export const STELLA_SCOPE_REQUEST = "stella/scope";

export interface ScopeRequestParams {
  uri: string;
  position: AnalysisPosition;
}

export type ScopeRequestResult = ScopeSnapshotView | null;
