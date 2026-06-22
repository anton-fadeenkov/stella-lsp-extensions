import type { AnalysisPosition } from "../analysis/analysis-types.js";
import type { TypeDerivationView } from "../analysis/type-derivation-types.js";

export const STELLA_TYPE_DERIVATION_REQUEST = "stella/typeDerivation";

export interface TypeDerivationRequestParams {
  uri: string;
  position: AnalysisPosition;
}

export type TypeDerivationRequestResult = TypeDerivationView | null;
