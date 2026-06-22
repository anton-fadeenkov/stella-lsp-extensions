import type { AstViewModel } from "../analysis/analysis-types.js";

/**
 * Пока сохраняем старое имя запроса, чтобы не ломать уже существующую логику.
 * Позже, если захочешь, можно переименовать в "stella/ast".
 */
export const STELLA_AST_REQUEST = "stella/syntaxTree";

export interface AstRequestParams {
  uri: string;
  maxDepth?: number;
}

export type AstRequestResult = AstViewModel | null;