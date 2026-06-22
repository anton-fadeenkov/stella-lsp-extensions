import { EmptyFileSystem } from "langium";
import { startLanguageServer } from "langium/lsp";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
} from "vscode-languageserver/browser.js";
import { createStellaServices } from "./stella-module.js";
import { registerSyntaxRequest } from "./lsp/syntax-request.js";
import { registerTypeDerivationRequest } from "./lsp/type-derivation-request.js";
import { registerTypeErrorTraceRequest } from "./lsp/type-error-trace-request.js";
import { registerScopeRequest } from "./lsp/scope-request.js";
import { registerTypeDependencyGraphRequest } from "./lsp/type-dependency-graph-request.js";

declare const self: DedicatedWorkerGlobalScope;

const messageReader = new BrowserMessageReader(self);
const messageWriter = new BrowserMessageWriter(self);

const connection = createConnection(messageReader, messageWriter);

const { shared, Stella } = createStellaServices({ connection, ...EmptyFileSystem });

registerSyntaxRequest(connection, Stella);
registerTypeDerivationRequest(connection, Stella);
registerTypeErrorTraceRequest(connection, Stella);
registerScopeRequest(connection, Stella);
registerTypeDependencyGraphRequest(connection, Stella);

startLanguageServer(shared);
