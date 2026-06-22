import type {
  AnalysisPosition,
  AnalysisRange,
} from "../analysis/analysis-types.js";
import type { TypeErrorTraceView } from "../analysis/type-error-trace-types.js";

export const STELLA_TYPE_ERROR_TRACE_REQUEST = "stella/typeErrorTrace";

export interface TypeErrorTraceRequestDiagnostic {
  message: string;
  range?: AnalysisRange;
  severity?: number;
}

export interface TypeErrorTraceRequestParams {
  uri: string;
  position: AnalysisPosition;
  diagnostic?: TypeErrorTraceRequestDiagnostic;
}

export type TypeErrorTraceRequestResult = TypeErrorTraceView | null;
