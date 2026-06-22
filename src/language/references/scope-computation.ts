import {
  AstNode,
  AstNodeDescription,
  DefaultScopeComputation,
  LangiumDocument,
} from "langium";

export class StellaScopeComputation extends DefaultScopeComputation {
  override async collectExportedSymbols(
    document: LangiumDocument<AstNode>
  ): Promise<AstNodeDescription[]> {
    // Stella does not support import/export statements
    // Every file is treated as a separate program
    return [];
  }
}
