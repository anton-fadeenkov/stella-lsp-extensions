import { AstNode, CstUtils, type LangiumDocument, URI } from "langium";
import { isType } from "typir";
import { Connection } from "vscode-languageserver/node.js";
import type {
  AnalysisPosition,
  AnalysisRange,
} from "../../shared/analysis/analysis-types.js";
import type {
  TypeDependencyGraphEdge,
  TypeDependencyGraphNode,
  TypeDependencyGraphNodeKind,
  TypeDependencyGraphView,
} from "../../shared/analysis/type-dependency-graph-types.js";
import {
  STELLA_TYPE_DEPENDENCY_GRAPH_REQUEST,
  type TypeDependencyGraphRequestParams,
  type TypeDependencyGraphRequestResult,
} from "../../shared/lsp/type-dependency-graph-protocol.js";
import { buildAstNodeId } from "../analysis/ast-utils.js";
import type { StellaServices } from "../stella-module.js";
import {
  isAbstraction,
  isAdd,
  isApplication,
  isAssign,
  isConstFalse,
  isConstInt,
  isConstTrue,
  isConstUnit,
  isDeclFun,
  isDeclFunGeneric,
  isDeref,
  isDivide,
  isEqual,
  isExpr,
  isGreaterThan,
  isGreaterThanOrEqual,
  isIf,
  isIsZero,
  isLessThan,
  isLessThanOrEqual,
  isLet,
  isLetRec,
  isLogicAnd,
  isLogicNot,
  isLogicOr,
  isMatch,
  isMultiply,
  isNatRec,
  isNotEqual,
  isParamDecl,
  isParenthesisedExpr,
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
  isPred,
  isRef,
  isSequence,
  isSubtraction,
  isSucc,
  isTryCastAs,
  isTryCatch,
  isTryWith,
  isTypeAsc,
  isVar,
  type Decl,
  type DeclFun,
  type DeclFunGeneric,
  type DeclValue,
  type Expr,
  type MatchCase,
  type ParamDecl,
  type Pattern,
  type PatternVar,
  type Type,
} from "../generated/ast.js";

const UNKNOWN_TYPE_TEXT = "?";

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

function resolveFocusNode(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  while (current) {
    if (isExpr(current) || isDeclFun(current) || isDeclFunGeneric(current)) {
      return current;
    }
    current = current.$container;
  }
  return node;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getNodeText(node: AstNode | Type | undefined): string | undefined {
  const text = node?.$cstNode?.text;
  return text ? normalizeText(text) : undefined;
}

function shorten(text: string | undefined, maxLength = 46): string | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function getNodeRange(node: AstNode | undefined): AnalysisRange | undefined {
  const range = node?.$cstNode?.range;
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
    // keep graph available even when inference fails for some nodes
  }

  return undefined;
}

function asDisplayType(typeText: string | undefined): string | undefined {
  const normalized = typeText ? normalizeText(typeText) : undefined;
  if (!normalized || normalized.toLowerCase() === "unknown") {
    return UNKNOWN_TYPE_TEXT;
  }
  return normalized;
}

function normalizeTypeText(typeText: string | undefined): string | undefined {
  return typeText ? normalizeText(typeText) : undefined;
}

function areTypesCompatible(left: string | undefined, right: string | undefined): boolean {
  const leftText = normalizeTypeText(left);
  const rightText = normalizeTypeText(right);
  if (!leftText || !rightText) {
    return true;
  }
  return leftText === rightText;
}

function parseFunctionSignature(typeText: string | undefined): {
  params: string[];
  returnType?: string;
} | undefined {
  const normalized = normalizeTypeText(typeText);
  if (!normalized || normalized === UNKNOWN_TYPE_TEXT) {
    return undefined;
  }

  if (normalized.startsWith("fn(")) {
    const closingParenIndex = normalized.indexOf(") -> ");
    if (closingParenIndex < 0) {
      return undefined;
    }

    const paramsText = normalized.slice(3, closingParenIndex);
    const returnType = normalized.slice(closingParenIndex + 5).trim();
    const params = paramsText.length === 0
      ? []
      : paramsText.split(",").map((entry) => normalizeText(entry));

    return {
      params,
      returnType,
    };
  }

  const arrowIndex = normalized.indexOf("->");
  if (arrowIndex > 0) {
    return {
      params: [normalizeText(normalized.slice(0, arrowIndex))],
      returnType: normalizeText(normalized.slice(arrowIndex + 2)),
    };
  }

  return undefined;
}

function getParamTypeText(param: ParamDecl, services: StellaServices): string {
  return (
    asDisplayType(getNodeText(param.paramType) ?? inferTypeText(param, services)) ??
    UNKNOWN_TYPE_TEXT
  );
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
    asDisplayType(
      (declaration.returnType ? getNodeText(declaration.returnType) : undefined) ??
        inferTypeText(declaration.returnExpr, services)
    ) ?? UNKNOWN_TYPE_TEXT;

  if (params.length === 1) {
    return `${params[0]} -> ${returnType}`;
  }

  return `fn(${params.join(", ")}) -> ${returnType}`;
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
      return asDisplayType(getNodeText(current.type)) ?? UNKNOWN_TYPE_TEXT;
    }

    if (isPatternBinding(current)) {
      return (
        asDisplayType(inferTypeText(current.rhs, services) ?? getNodeText(current.rhs)) ??
        UNKNOWN_TYPE_TEXT
      );
    }

    if (isParamDecl(current)) {
      return getParamTypeText(current, services);
    }

    current = current.$container;
  }

  return UNKNOWN_TYPE_TEXT;
}

function getEnclosingFunction(node: AstNode): DeclFun | DeclFunGeneric | undefined {
  let current: AstNode | undefined = node;
  while (current) {
    if (isDeclFun(current) || isDeclFunGeneric(current)) {
      return current;
    }
    current = current.$container;
  }
  return undefined;
}

function getDeclName(node: DeclValue | AstNode): string {
  if (isDeclFun(node) || isDeclFunGeneric(node) || isParamDecl(node) || isPatternVar(node)) {
    return node.name;
  }
  return shorten(getNodeText(node), 32) ?? node.$type;
}

function getExpressionLabel(expr: Expr): string {
  if (isVar(expr)) {
    const target = expr.ref.ref as (DeclValue | AstNode | undefined);
    return expr.ref.$refText ?? (target ? getDeclName(target) : expr.$type);
  }

  if (isConstTrue(expr) || isConstFalse(expr) || isConstInt(expr) || isConstUnit(expr)) {
    return getNodeText(expr) ?? expr.$type;
  }

  return shorten(getNodeText(expr), 42) ?? expr.$type;
}

function getExpressionDetail(expr: Expr): string | undefined {
  return getNodeText(expr) ?? expr.$type;
}

function getExpressionType(expr: Expr, services: StellaServices): string | undefined {
  if (isTypeAsc(expr)) {
    return asDisplayType(getNodeText(expr.type) ?? inferTypeText(expr.expr, services));
  }

  return asDisplayType(inferTypeText(expr, services));
}

function getPatternSummary(pattern: Pattern): string {
  return shorten(getNodeText(pattern), 36) ?? pattern.$type;
}

class GraphBuilder {
  private readonly nodes = new Map<string, TypeDependencyGraphNode>();
  private readonly edges = new Map<string, TypeDependencyGraphEdge>();

  addNode(node: TypeDependencyGraphNode): void {
    const existing = this.nodes.get(node.id);
    if (existing) {
      existing.layer = Math.max(existing.layer, node.layer);
      existing.isFocused = existing.isFocused || node.isFocused;
      existing.isConflict = existing.isConflict || node.isConflict;
      existing.label = existing.label || node.label;
      existing.typeLabel = existing.typeLabel || node.typeLabel;
      existing.detail = existing.detail || node.detail;
      existing.range = existing.range || node.range;
      if (existing.kind !== "selected" && node.kind === "selected") {
        existing.kind = node.kind;
      }
      return;
    }

    this.nodes.set(node.id, { ...node });
  }

  markNodeConflict(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.isConflict = true;
    }
  }

  addEdge(
    from: string,
    to: string,
    label?: string,
    kind?: string,
    isConflict = false
  ): void {
    const edgeId = `${from}=>${to}:${label ?? ""}`;
    const existing = this.edges.get(edgeId);
    if (existing) {
      existing.isConflict = existing.isConflict || isConflict;
      return;
    }

    this.edges.set(edgeId, {
      id: edgeId,
      from,
      to,
      label,
      kind,
      isConflict,
    });
  }

  buildView(
    documentUri: string,
    rootNodeId: string,
    title: string,
    summary?: string
  ): TypeDependencyGraphView {
    const nodes = Array.from(this.nodes.values());
    const maxLayer = nodes.reduce((max, node) => Math.max(max, node.layer), 0);

    for (const node of nodes) {
      node.layer = maxLayer - node.layer;
    }

    nodes.sort((left, right) => {
      if (left.layer !== right.layer) {
        return left.layer - right.layer;
      }
      if (left.kind !== right.kind) {
        return left.kind.localeCompare(right.kind);
      }
      return left.label.localeCompare(right.label);
    });

    const edges = Array.from(this.edges.values());

    return {
      documentUri,
      title,
      summary,
      rootNodeId,
      nodes,
      edges,
    };
  }
}

function addDeclarationNode(
  builder: GraphBuilder,
  declaration: DeclValue | AstNode,
  services: StellaServices,
  depth: number,
  preferredKind?: TypeDependencyGraphNodeKind
): string {
  const baseId = buildAstNodeId(declaration as AstNode);
  const nodeId = `decl:${baseId}`;

  let kind: TypeDependencyGraphNodeKind = preferredKind ?? "binding";
  let label = getDeclName(declaration);
  let typeLabel: string | undefined;
  let detail: string | undefined;

  if (isDeclFun(declaration) || isDeclFunGeneric(declaration)) {
    kind = preferredKind ?? "function";
    typeLabel = asDisplayType(getFunctionTypeText(declaration, services));
    detail = `${declaration.name} : ${typeLabel ?? UNKNOWN_TYPE_TEXT}`;
  } else if (isParamDecl(declaration)) {
    kind = preferredKind ?? "parameter";
    typeLabel = getParamTypeText(declaration, services);
    detail = `${declaration.name} : ${typeLabel}`;
  } else if (isPatternVar(declaration)) {
    kind = preferredKind ?? "binding";
    typeLabel = getPatternVarTypeText(declaration, services);
    detail = `${declaration.name} : ${typeLabel}`;
  } else {
    typeLabel = asDisplayType(inferTypeText(declaration, services));
    detail = shorten(getNodeText(declaration), 52);
  }

  builder.addNode({
    id: nodeId,
    label,
    kind,
    layer: depth,
    typeLabel,
    detail,
    range: getNodeRange(declaration as AstNode),
  });

  return nodeId;
}

function addPatternBindingNode(
  builder: GraphBuilder,
  binding: { pattern: Pattern },
  services: StellaServices,
  depth: number,
  suffix: string
): string {
  const firstVar = collectPatternVars(binding.pattern)[0];
  const typeLabel = firstVar ? getPatternVarTypeText(firstVar, services) : undefined;
  const nodeId = `binding:${buildAstNodeId(binding as unknown as AstNode)}:${suffix}`;

  builder.addNode({
    id: nodeId,
    label: getPatternSummary(binding.pattern),
    kind: "binding",
    layer: depth,
    typeLabel,
    detail: `pattern ${getPatternSummary(binding.pattern)}`,
    range: getNodeRange(binding.pattern),
  });

  return nodeId;
}

function addMatchCaseNode(builder: GraphBuilder, matchCase: MatchCase, depth: number): string {
  const nodeId = `case:${buildAstNodeId(matchCase)}`;
  builder.addNode({
    id: nodeId,
    label: getPatternSummary(matchCase.pattern),
    kind: "case",
    layer: depth,
    detail: shorten(getNodeText(matchCase.expr), 50),
    range: getNodeRange(matchCase),
  });
  return nodeId;
}

function addExpressionNode(
  builder: GraphBuilder,
  expr: Expr,
  services: StellaServices,
  depth: number,
  isFocused = false
): string {
  const nodeId = buildAstNodeId(expr);

  builder.addNode({
    id: nodeId,
    label: getExpressionLabel(expr),
    kind: isFocused ? "selected" : "expression",
    layer: depth,
    typeLabel: getExpressionType(expr, services),
    detail: getExpressionDetail(expr),
    range: getNodeRange(expr),
    isFocused,
  });

  return nodeId;
}

function connectUnaryDependency(
  builder: GraphBuilder,
  parentId: string,
  child: Expr,
  services: StellaServices,
  depth: number,
  label: string,
  expectedType?: string
): void {
  const childId = visitDependencyGraph(child, builder, services, depth + 1);
  const childType = getExpressionType(child, services);
  const isConflict = expectedType ? !areTypesCompatible(expectedType, childType) : false;
  if (isConflict) {
    builder.markNodeConflict(childId);
    builder.markNodeConflict(parentId);
  }
  builder.addEdge(childId, parentId, label, "dependency", isConflict);
}

function connectBinaryDependencies(
  builder: GraphBuilder,
  parentId: string,
  left: Expr,
  right: Expr,
  services: StellaServices,
  depth: number,
  labels: [string, string],
  expectedType?: string
): void {
  connectUnaryDependency(builder, parentId, left, services, depth, labels[0], expectedType);
  connectUnaryDependency(builder, parentId, right, services, depth, labels[1], expectedType);
}

function visitApplicationDependencies(
  node: Expr,
  builder: GraphBuilder,
  services: StellaServices,
  depth: number,
  application: ReturnType<typeof addExpressionNode>
): void {
  if (!isApplication(node)) {
    return;
  }

  const funId = visitDependencyGraph(node.fun, builder, services, depth + 1);
  builder.addEdge(funId, application, "callee", "dependency");

  const calleeType = getExpressionType(node.fun, services);
  const signature = parseFunctionSignature(calleeType);

  node.args.forEach((arg, index) => {
    const argId = visitDependencyGraph(arg, builder, services, depth + 1);
    const argType = getExpressionType(arg, services);
    const expectedType = signature?.params[index];
    const isConflict = expectedType ? !areTypesCompatible(expectedType, argType) : false;

    if (isConflict) {
      builder.markNodeConflict(argId);
      builder.markNodeConflict(funId);
      builder.markNodeConflict(application);
    }

    builder.addEdge(
      argId,
      application,
      expectedType ? `arg ${index + 1} · ${expectedType}` : `arg ${index + 1}`,
      "dependency",
      isConflict
    );
  });

  if (isVar(node.fun)) {
    const target = node.fun.ref.ref as DeclValue | AstNode | undefined;
    if (target) {
      const declId = addDeclarationNode(builder, target, services, depth + 2);
      builder.addEdge(declId, funId, "definition", "binding");
    }
  }
}

function visitDependencyGraph(
  node: Expr,
  builder: GraphBuilder,
  services: StellaServices,
  depth = 0,
  isFocused = false
): string {
  const nodeId = addExpressionNode(builder, node, services, depth, isFocused);

  if (isParenthesisedExpr(node)) {
    connectUnaryDependency(builder, nodeId, node.expr, services, depth, "inner");
    return nodeId;
  }

  if (isAbstraction(node)) {
    node.paramDecls.forEach((param, index) => {
      const paramId = addDeclarationNode(builder, param, services, depth + 1, "parameter");
      builder.addEdge(paramId, nodeId, `param ${index + 1}`, "binding");
    });
    connectUnaryDependency(builder, nodeId, node.returnExpr, services, depth, "body");
    return nodeId;
  }

  if (isApplication(node)) {
    visitApplicationDependencies(node, builder, services, depth, nodeId);
    return nodeId;
  }

  if (isIf(node)) {
    const conditionId = visitDependencyGraph(node.condition, builder, services, depth + 1);
    const thenId = visitDependencyGraph(node.thenExpr, builder, services, depth + 1);
    const elseId = visitDependencyGraph(node.elseExpr, builder, services, depth + 1);
    const conditionConflict = !areTypesCompatible("Bool", getExpressionType(node.condition, services));
    const branchConflict = !areTypesCompatible(
      getExpressionType(node.thenExpr, services),
      getExpressionType(node.elseExpr, services)
    );

    if (conditionConflict) {
      builder.markNodeConflict(conditionId);
      builder.markNodeConflict(nodeId);
    }

    if (branchConflict) {
      builder.markNodeConflict(thenId);
      builder.markNodeConflict(elseId);
      builder.markNodeConflict(nodeId);
    }

    builder.addEdge(conditionId, nodeId, "condition · Bool", "dependency", conditionConflict);
    builder.addEdge(thenId, nodeId, "then", "dependency", branchConflict);
    builder.addEdge(elseId, nodeId, "else", "dependency", branchConflict);
    return nodeId;
  }

  if (isLet(node) || isLetRec(node)) {
    node.patternBindings.forEach((binding, index) => {
      const bindingNodeId = addPatternBindingNode(builder, binding, services, depth + 1, `${index}`);
      const rhsId = visitDependencyGraph(binding.rhs, builder, services, depth + 2);
      builder.addEdge(rhsId, bindingNodeId, "value", "dependency");
      builder.addEdge(bindingNodeId, nodeId, node.$type === "LetRec" ? "recursive binding" : "binding", "binding");
    });
    connectUnaryDependency(builder, nodeId, node.body, services, depth, "body");
    return nodeId;
  }

  if (isMatch(node)) {
    connectUnaryDependency(builder, nodeId, node.expr, services, depth, "subject");
    node.cases.forEach((matchCase) => {
      const caseId = addMatchCaseNode(builder, matchCase, depth + 1);
      const exprId = visitDependencyGraph(matchCase.expr, builder, services, depth + 2);
      builder.addEdge(exprId, caseId, "result", "dependency");
      builder.addEdge(caseId, nodeId, "case", "dependency");
    });
    return nodeId;
  }

  if (isTypeAsc(node)) {
    connectUnaryDependency(builder, nodeId, node.expr, services, depth, `expr · ${getNodeText(node.type) ?? UNKNOWN_TYPE_TEXT}`);
    return nodeId;
  }

  if (isRef(node)) {
    connectUnaryDependency(builder, nodeId, node.expr, services, depth, "value");
    return nodeId;
  }

  if (isDeref(node)) {
    connectUnaryDependency(builder, nodeId, node.expr, services, depth, "reference");
    return nodeId;
  }

  if (isSucc(node) || isPred(node) || isIsZero(node)) {
    const child = isSucc(node) ? node.n : isPred(node) ? node.n : node.n;
    connectUnaryDependency(builder, nodeId, child, services, depth, "operand", "Nat");
    return nodeId;
  }

  if (isLogicNot(node)) {
    connectUnaryDependency(builder, nodeId, node.expr, services, depth, "operand", "Bool");
    return nodeId;
  }

  if (isSequence(node)) {
    connectBinaryDependencies(builder, nodeId, node.expr1, node.expr2, services, depth, ["first", "second"]);
    return nodeId;
  }

  if (isAssign(node)) {
    connectBinaryDependencies(builder, nodeId, node.left, node.right, services, depth, ["target", "value"]);
    return nodeId;
  }

  if (
    isAdd(node) ||
    isSubtraction(node) ||
    isMultiply(node) ||
    isDivide(node)
  ) {
    connectBinaryDependencies(builder, nodeId, node.left, node.right, services, depth, ["left · Nat", "right · Nat"], "Nat");
    return nodeId;
  }

  if (
    isLogicAnd(node) ||
    isLogicOr(node)
  ) {
    connectBinaryDependencies(builder, nodeId, node.left, node.right, services, depth, ["left · Bool", "right · Bool"], "Bool");
    return nodeId;
  }

  if (
    isEqual(node) ||
    isNotEqual(node) ||
    isLessThan(node) ||
    isLessThanOrEqual(node) ||
    isGreaterThan(node) ||
    isGreaterThanOrEqual(node)
  ) {
    connectBinaryDependencies(builder, nodeId, node.left, node.right, services, depth, ["left", "right"]);
    return nodeId;
  }

  if (isNatRec(node)) {
    connectUnaryDependency(builder, nodeId, node.n, services, depth, "n · Nat", "Nat");
    connectUnaryDependency(builder, nodeId, node.initial, services, depth, "initial");
    connectUnaryDependency(builder, nodeId, node.step, services, depth, "step");
    return nodeId;
  }

  if (isTryCatch(node)) {
    connectUnaryDependency(builder, nodeId, node.tryExpr, services, depth, "try");
    const fallbackId = visitDependencyGraph(node.fallbackExpr, builder, services, depth + 1);
    const catchNodeId = addPatternBindingNode(builder, node, services, depth + 1, "catch");
    builder.addEdge(fallbackId, catchNodeId, "fallback", "dependency");
    builder.addEdge(catchNodeId, nodeId, "catch", "dependency");
    return nodeId;
  }

  if (isTryWith(node)) {
    connectUnaryDependency(builder, nodeId, node.tryExpr, services, depth, "try");
    connectUnaryDependency(builder, nodeId, node.fallbackExpr, services, depth, "with");
    return nodeId;
  }

  if (isTryCastAs(node)) {
    connectUnaryDependency(builder, nodeId, node.tryExpr, services, depth, "try");
    connectUnaryDependency(builder, nodeId, node.expr, services, depth, "success");
    return nodeId;
  }

  if (isVar(node)) {
    const target = node.ref.ref as DeclValue | AstNode | undefined;
    if (target) {
      const declarationId = addDeclarationNode(builder, target, services, depth + 1);
      builder.addEdge(declarationId, nodeId, "binds", "binding");
    }
    return nodeId;
  }

  return nodeId;
}

function buildFunctionContext(
  builder: GraphBuilder,
  focusedNodeId: string,
  activeNode: AstNode,
  services: StellaServices
): string | undefined {
  const enclosingFunction = getEnclosingFunction(activeNode);
  if (!enclosingFunction) {
    return undefined;
  }

  const functionId = addDeclarationNode(builder, enclosingFunction, services, 1, "function");
  const relationLabel =
    (isDeclFun(enclosingFunction) || isDeclFunGeneric(enclosingFunction)) &&
    activeNode === enclosingFunction.returnExpr
      ? "declared return"
      : "encloses";

  let isConflict = false;
  if (
    (isDeclFun(enclosingFunction) || isDeclFunGeneric(enclosingFunction)) &&
    activeNode === enclosingFunction.returnExpr
  ) {
    const declaredType = enclosingFunction.returnType
      ? getNodeText(enclosingFunction.returnType)
      : undefined;
    const actualType = getExpressionType(enclosingFunction.returnExpr, services);
    isConflict = !areTypesCompatible(declaredType, actualType);
    if (isConflict) {
      builder.markNodeConflict(functionId);
      builder.markNodeConflict(focusedNodeId);
    }
  }

  builder.addEdge(functionId, focusedNodeId, relationLabel, "context", isConflict);

  return `${enclosingFunction.name} : ${getFunctionTypeText(enclosingFunction, services) ?? UNKNOWN_TYPE_TEXT}`;
}

function buildGraphForFocusNode(
  activeNode: AstNode,
  documentUri: string,
  services: StellaServices
): TypeDependencyGraphView | null {
  const builder = new GraphBuilder();

  if (isDeclFun(activeNode) || isDeclFunGeneric(activeNode)) {
    const functionId = addDeclarationNode(builder, activeNode, services, 0, "selected");

    activeNode.paramDecls.forEach((param, index) => {
      const paramId = addDeclarationNode(builder, param, services, 1, "parameter");
      builder.addEdge(paramId, functionId, `param ${index + 1}`, "binding");
    });

    const bodyId = visitDependencyGraph(activeNode.returnExpr, builder, services, 1);
    builder.addEdge(bodyId, functionId, "return", "dependency");

    return builder.buildView(
      documentUri,
      functionId,
      `Type dependency graph · ${activeNode.name}`,
      `Function signature: ${getFunctionTypeText(activeNode, services) ?? UNKNOWN_TYPE_TEXT}`
    );
  }

  if (!isExpr(activeNode)) {
    return null;
  }

  const rootNodeId = visitDependencyGraph(activeNode, builder, services, 0, true);
  const functionSummary = buildFunctionContext(builder, rootNodeId, activeNode, services);
  const typeLabel = getExpressionType(activeNode, services) ?? UNKNOWN_TYPE_TEXT;
  const title = `Type dependency graph · ${getExpressionLabel(activeNode)}`;
  const summary = [
    `Selected expression type: ${typeLabel}`,
    functionSummary ? `enclosing function: ${functionSummary}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return builder.buildView(documentUri, rootNodeId, title, summary);
}

export function registerTypeDependencyGraphRequest(
  connection: Connection,
  services: StellaServices
): void {
  connection.onRequest(
    STELLA_TYPE_DEPENDENCY_GRAPH_REQUEST,
    async (
      params: TypeDependencyGraphRequestParams
    ): Promise<TypeDependencyGraphRequestResult> => {
      const document = await resolveDocument(services, params.uri);
      await services.shared.workspace.DocumentBuilder.build([document], {
        validation: true,
      });

      const nodeAtPosition = findAstNodeAtPosition(document, params.position);
      const focusNode = resolveFocusNode(nodeAtPosition);
      if (!focusNode) {
        return null;
      }

      return buildGraphForFocusNode(focusNode, document.uri.toString(), services);
    }
  );
}
