import { URI } from "langium";
import type { LangiumDocument } from "langium";
import { Connection } from "vscode-languageserver/node.js";
import { serializeAstTree } from "../analysis/ast-utils.js";
import type {
  AstRequestParams,
  AstRequestResult,
} from "../../shared/lsp/ast-protocol.js";
import { STELLA_AST_REQUEST } from "../../shared/lsp/ast-protocol.js";
import { StellaServices } from "../stella-module.js";

function normalizeUriString(uri: string): string {
  return decodeURIComponent(uri).replace(
    /^file:\/\/\/([A-Za-z]):/,
    (_, drive: string) => `file:///${drive.toLowerCase()}:`
  );
}

function findExistingDocument(
  services: StellaServices,
  uriString: string
): LangiumDocument | undefined {
  const documents = services.shared.workspace.LangiumDocuments;
  const parsedUri = URI.parse(uriString);

  const directMatch = documents.getDocument(parsedUri);
  if (directMatch) {
    return directMatch;
  }

  const normalizedTarget = normalizeUriString(uriString);

  for (const document of documents.all) {
    const candidateUri = document.uri.toString();
    if (candidateUri === uriString) {
      return document;
    }

    if (normalizeUriString(candidateUri) === normalizedTarget) {
      return document;
    }
  }

  return undefined;
}

async function resolveDocument(
  services: StellaServices,
  uriString: string
): Promise<LangiumDocument> {
  const documents = services.shared.workspace.LangiumDocuments;

  const existingDocument = findExistingDocument(services, uriString);
  if (existingDocument) {
    return existingDocument;
  }

  const parsedUri = URI.parse(uriString);

  try {
    return await documents.getOrCreateDocument(parsedUri);
  } catch (error) {
    const fallbackDocument = findExistingDocument(services, uriString);
    if (fallbackDocument) {
      return fallbackDocument;
    }

    throw error;
  }
}

export function registerSyntaxRequest(
  connection: Connection,
  services: StellaServices
): void {
  connection.onRequest(
    STELLA_AST_REQUEST,
    async (params: AstRequestParams): Promise<AstRequestResult> => {
      const document = await resolveDocument(services, params.uri);
      const root = document.parseResult.value;

      return serializeAstTree(root, params.uri, params.maxDepth);
    }
  );
}