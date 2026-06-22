import type { AstViewModel } from "../analysis/analysis-types.js";

/**
 * Keep the existing request name to avoid breaking the current client logic.
 * It can be renamed to "stella/ast" later if needed.
 */
export const STELLA_AST_REQUEST = "stella/syntaxTree";

export interface AstRequestParams {
  uri: string;
  maxDepth?: number;
}

export type AstRequestResult = AstViewModel | null;
