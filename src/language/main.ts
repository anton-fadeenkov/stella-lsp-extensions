import { startLanguageServer } from "langium/lsp";
import { NodeFileSystem } from "langium/node";
import {
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node.js";
import { createStellaServices } from "./stella-module.js";
import { registerSyntaxRequest } from "./lsp/syntax-request.js";
import { registerTypeDerivationRequest } from "./lsp/type-derivation-request.js";
import { registerTypeErrorTraceRequest } from "./lsp/type-error-trace-request.js";
import { registerScopeRequest } from "./lsp/scope-request.js";
import { registerTypeDependencyGraphRequest } from "./lsp/type-dependency-graph-request.js";

const connection = createConnection(ProposedFeatures.all);

const { shared, Stella } = createStellaServices({
  connection,
  ...NodeFileSystem,
});

registerSyntaxRequest(connection, Stella);
registerTypeDerivationRequest(connection, Stella);
registerTypeErrorTraceRequest(connection, Stella);
registerScopeRequest(connection, Stella);
registerTypeDependencyGraphRequest(connection, Stella);

startLanguageServer(shared);
