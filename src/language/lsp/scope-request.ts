import { AstNode, CstUtils, type LangiumDocument, URI } from "langium";
import { isType } from "typir";
import { Connection } from "vscode-languageserver/node.js";
import type {
  AnalysisPosition,
  AnalysisRange,
} from "../../shared/analysis/analysis-types.js";
import type {
  ScopeBindingView,
  ScopeFrameView,
  ScopeSnapshotView,
} from "../../shared/analysis/scope-types.js";
import {
  STELLA_SCOPE_REQUEST,
  type ScopeRequestParams,
  type ScopeRequestResult,
} from "../../shared/lsp/scope-protocol.js";
import { buildAstNodeId, getAstNodeLabel } from "../analysis/ast-utils.js";
import type { StellaServices } from "../stella-module.js";
import {
  isAbstraction,
  isDeclFun,
  isDeclFunGeneric,
  isExpr,
  isLet,
  isLetRec,
  isMatchCase,
  isParamDecl,
  isParenthesisedPattern,
  isPatternAsc,
  isPatternBinding,
  isPatternCastAs,
  isPatternCons,
  isPatternInl,
  isPatternInr,
  isPatternList,
  isPatternRecord,
  isPatternSucc,
  isPatternTuple,
  isPatternVar,
  isPatternVariant,
  isProgram,
  isTryCastAs,
  isTryCatch,
  type Decl,
  type ParamDecl,
  type Pattern,
  type PatternVar,
} from "../generated/ast.js";

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

function findAstNodeAtPosition(
  document: LangiumDocument,
  position: AnalysisPosition
): AstNode | undefined {
  const rootNode = document.parseResult.value;
  const rootCst = rootNode.$cstNode;
  if (!rootCst) {
    return rootNode;
  }

  const offset = document.textDocument.offsetAt({
    line: position.line,
    character: position.character,
  });

  const leaf = CstUtils.findLeafNodeAtOffset(rootCst, offset);
  return leaf?.astNode ?? rootNode;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getNodeText(node: AstNode | undefined): string | undefined {
  const text = node?.$cstNode?.text;
  return text ? normalizeText(text) : undefined;
}

function getNodeRange(node: AstNode): AnalysisRange | undefined {
  const range = node.$cstNode?.range;
  if (!range) {
    return undefined;
  }

  return {
    start: {
      line: range.start.line,
      character: range.start.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  };
}

function inferTypeText(
  node: AstNode,
  services: StellaServices
): string | undefined {
  try {
    const inferred = services.typir.Inference.inferType(node);
    if (isType(inferred)) {
      return normalizeText(inferred.getName());
    }
  } catch {
    // keep scope view available even if inference fails for some nodes
  }

  return undefined;
}

function getParamTypeText(param: ParamDecl, services: StellaServices): string {
  return getNodeText(param.paramType) ?? inferTypeText(param, services) ?? "unknown";
}

function getFunctionTypeText(
  declaration: Decl,
  services: StellaServices
): string | undefined {
  if (!isDeclFun(declaration) && !isDeclFunGeneric(declaration)) {
    return inferTypeText(declaration, services);
  }

  const params = declaration.paramDecls.map((param) => getParamTypeText(param, services));
  const returnType =
    (declaration.returnType ? getNodeText(declaration.returnType) : undefined) ??
    inferTypeText(declaration.returnExpr, services) ??
    "unknown";

  if (params.length === 1) {
    return `${params[0]} -> ${returnType}`;
  }

  return `fn(${params.join(", ")}) -> ${returnType}`;
}

function comparePositions(
  left: AnalysisPosition,
  right: AnalysisPosition
): number {
  if (left.line < right.line) {
    return -1;
  }
  if (left.line > right.line) {
    return 1;
  }
  if (left.character < right.character) {
    return -1;
  }
  if (left.character > right.character) {
    return 1;
  }
  return 0;
}

function startsBeforeOrAt(
  range: AnalysisRange | undefined,
  position: AnalysisPosition
): boolean {
  if (!range) {
    return true;
  }

  return comparePositions(range.start, position) <= 0;
}

function isSameOrDescendant(node: AstNode, possibleAncestor: AstNode): boolean {
  let current: AstNode | undefined = node;
  while (current) {
    if (current === possibleAncestor) {
      return true;
    }
    current = current.$container;
  }
  return false;
}

function collectPatternVars(pattern: Pattern): PatternVar[] {
  if (isPatternVar(pattern)) {
    return [pattern];
  }

  if (
    isParenthesisedPattern(pattern) ||
    isPatternAsc(pattern) ||
    isPatternCastAs(pattern) ||
    isPatternInl(pattern) ||
    isPatternInr(pattern) ||
    isPatternSucc(pattern)
  ) {
    return collectPatternVars(pattern.pattern);
  }

  if (isPatternVariant(pattern) && pattern.pattern) {
    return collectPatternVars(pattern.pattern);
  }

  if (isPatternTuple(pattern) || isPatternList(pattern)) {
    return pattern.patterns.flatMap((entry) => collectPatternVars(entry));
  }

  if (isPatternRecord(pattern)) {
    return pattern.patterns.flatMap((entry) => collectPatternVars(entry.pattern));
  }

  if (isPatternCons(pattern)) {
    return collectPatternVars(pattern.head).concat(collectPatternVars(pattern.tail));
  }

  return [];
}

function getPatternVarTypeText(
  patternVar: PatternVar,
  services: StellaServices
): string {
  const inferred = inferTypeText(patternVar, services);
  if (inferred) {
    return inferred;
  }

  let current: AstNode | undefined = patternVar.$container;
  while (current) {
    if (isPatternAsc(current) || isPatternCastAs(current)) {
      return getNodeText(current.type) ?? "unknown";
    }

    if (isPatternBinding(current)) {
      return inferTypeText(current.rhs, services) ?? getNodeText(current.rhs) ?? "unknown";
    }

    if (isParamDecl(current)) {
      return getParamTypeText(current, services);
    }

    current = current.$container;
  }

  return "unknown";
}

function pushUniqueBinding(
  target: ScopeBindingView[],
  binding: ScopeBindingView
): void {
  if (target.some((entry) => entry.name === binding.name && entry.sourceNodeId === binding.sourceNodeId)) {
    return;
  }

  target.push(binding);
}

function createBinding(
  name: string,
  kind: string,
  typeLabel: string,
  node: AstNode
): ScopeBindingView {
  return {
    id: `${buildAstNodeId(node)}:${name}`,
    name,
    kind,
    typeLabel,
    sourceNodeId: buildAstNodeId(node),
    sourceLabel: getAstNodeLabel(node),
    range: getNodeRange(node),
  };
}

function addDeclarationBindings(
  target: ScopeBindingView[],
  declarations: Decl[],
  services: StellaServices,
  activePosition: AnalysisPosition,
  respectOrder: boolean,
  kind = "function"
): void {
  for (const declaration of declarations) {
    if (respectOrder && !startsBeforeOrAt(getNodeRange(declaration), activePosition)) {
      continue;
    }

    if (isDeclFun(declaration) || isDeclFunGeneric(declaration)) {
      pushUniqueBinding(
        target,
        createBinding(
          declaration.name,
          kind,
          getFunctionTypeText(declaration, services) ?? "unknown",
          declaration
        )
      );
    }
  }
}

function addParameterBindings(
  target: ScopeBindingView[],
  params: ParamDecl[],
  services: StellaServices
): void {
  for (const param of params) {
    pushUniqueBinding(
      target,
      createBinding(param.name, "parameter", getParamTypeText(param, services), param)
    );
  }
}

function addPatternBindings(
  target: ScopeBindingView[],
  pattern: Pattern,
  services: StellaServices
): void {
  for (const patternVar of collectPatternVars(pattern)) {
    pushUniqueBinding(
      target,
      createBinding(
        patternVar.name,
        "pattern",
        getPatternVarTypeText(patternVar, services),
        patternVar
      )
    );
  }
}

function getAncestors(node: AstNode): AstNode[] {
  const ancestors: AstNode[] = [];
  let current = node.$container;

  while (current) {
    ancestors.unshift(current);
    current = current.$container;
  }

  return ancestors;
}

function getScopeFrameLabel(node: AstNode, index: number): string {
  if (isProgram(node)) {
    return `Γ${index} • program`;
  }

  if (isDeclFun(node) || isDeclFunGeneric(node)) {
    return `Γ${index} • function ${node.name}`;
  }

  if (isAbstraction(node)) {
    return `Γ${index} • lambda`;
  }

  if (isLet(node)) {
    return `Γ${index} • let`;
  }

  if (isLetRec(node)) {
    return `Γ${index} • letrec`;
  }

  if (isMatchCase(node)) {
    return `Γ${index} • match case`;
  }

  if (isTryCatch(node)) {
    return `Γ${index} • catch`;
  }

  if (isTryCastAs(node)) {
    return `Γ${index} • cast pattern`;
  }

  return `Γ${index} • ${node.$type}`;
}

function buildFrameForScopeNode(
  scopeNode: AstNode,
  activeNode: AstNode,
  activePosition: AnalysisPosition,
  services: StellaServices,
  index: number
): ScopeFrameView | undefined {
  const bindings: ScopeBindingView[] = [];

  if (isProgram(scopeNode)) {
    addDeclarationBindings(bindings, scopeNode.decls, services, activePosition, false, "function");
  } else if (isDeclFun(scopeNode) || isDeclFunGeneric(scopeNode)) {
    pushUniqueBinding(
      bindings,
      createBinding(
        scopeNode.name,
        "function",
        getFunctionTypeText(scopeNode, services) ?? "unknown",
        scopeNode
      )
    );
    addParameterBindings(bindings, scopeNode.paramDecls, services);
    addDeclarationBindings(bindings, scopeNode.localDecls, services, activePosition, true, "local declaration");
  } else if (isAbstraction(scopeNode)) {
    addParameterBindings(bindings, scopeNode.paramDecls, services);
  } else if (isLet(scopeNode) && isSameOrDescendant(activeNode, scopeNode.body)) {
    for (const binding of scopeNode.patternBindings) {
      addPatternBindings(bindings, binding.pattern, services);
    }
  } else if (isLetRec(scopeNode)) {
    for (const binding of scopeNode.patternBindings) {
      addPatternBindings(bindings, binding.pattern, services);
    }
  } else if (isMatchCase(scopeNode) && isSameOrDescendant(activeNode, scopeNode.expr)) {
    addPatternBindings(bindings, scopeNode.pattern, services);
  } else if (isTryCatch(scopeNode) && isSameOrDescendant(activeNode, scopeNode.fallbackExpr)) {
    addPatternBindings(bindings, scopeNode.pattern, services);
  } else if (isTryCastAs(scopeNode) && isSameOrDescendant(activeNode, scopeNode.expr)) {
    addPatternBindings(bindings, scopeNode.pattern, services);
  }

  if (bindings.length === 0) {
    return undefined;
  }

  return {
    id: `${buildAstNodeId(scopeNode)}:frame`,
    label: getScopeFrameLabel(scopeNode, index),
    bindings,
  };
}

function buildScopeSnapshot(
  activeNode: AstNode,
  documentUri: string,
  activePosition: AnalysisPosition,
  services: StellaServices
): ScopeSnapshotView {
  const scopeNodes = getAncestors(activeNode).filter(
    (node) =>
      isProgram(node) ||
      isDeclFun(node) ||
      isDeclFunGeneric(node) ||
      isAbstraction(node) ||
      isLet(node) ||
      isLetRec(node) ||
      isMatchCase(node) ||
      isTryCatch(node) ||
      isTryCastAs(node)
  );

  const frames = [...scopeNodes]
    .reverse()
    .map((node, index) =>
      buildFrameForScopeNode(node, activeNode, activePosition, services, index)
    )
    .filter((frame): frame is ScopeFrameView => Boolean(frame));

  return {
    documentUri,
    activeNodeId: buildAstNodeId(activeNode),
    activeNodeLabel: getAstNodeLabel(activeNode),
    activeNodeType: activeNode.$type,
    activeRange: getNodeRange(activeNode),
    frames,
  };
}

export function registerScopeRequest(
  connection: Connection,
  services: StellaServices
): void {
  connection.onRequest(
    STELLA_SCOPE_REQUEST,
    async (params: ScopeRequestParams): Promise<ScopeRequestResult> => {
      const document = await resolveDocument(services, params.uri);
      const rawNode = findAstNodeAtPosition(document, params.position);
      const activeNode = rawNode && isExpr(rawNode) ? rawNode : rawNode ?? document.parseResult.value;
      if (!activeNode) {
        return null;
      }

      return buildScopeSnapshot(activeNode, params.uri, params.position, services);
    }
  );
}
