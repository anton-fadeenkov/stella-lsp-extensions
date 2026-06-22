import { AstNode, CstUtils, type LangiumDocument, URI } from "langium";
import { isType } from "typir";
import { Connection } from "vscode-languageserver/node.js";
import type {
  AnalysisPosition,
  AnalysisRange,
} from "../../shared/analysis/analysis-types.js";
import type {
  TypeDerivationNode,
  TypeDerivationView,
} from "../../shared/analysis/type-derivation-types.js";
import {
  STELLA_TYPE_DERIVATION_REQUEST,
  type TypeDerivationRequestParams,
  type TypeDerivationRequestResult,
} from "../../shared/lsp/type-derivation-protocol.js";
import type { StellaServices } from "../stella-module.js";
import { buildAstNodeId } from "../analysis/ast-utils.js";
import {
  isAbstraction,
  isAdd,
  isDivide,
  isEqual,
  isGreaterThan,
  isGreaterThanOrEqual,
  isLessThan,
  isLessThanOrEqual,
  isMultiply,
  isNotEqual,
  isApplication,
  isAssign,
  isConstFalse,
  isConstInt,
  isConstTrue,
  isConstUnit,
  isDeref,
  isDeclExceptionType,
  isDeclExceptionVariant,
  isDeclFun,
  isDeclFunGeneric,
  isExpr,
  isIf,
  isIsZero,
  isLet,
  isLetRec,
  isLogicAnd,
  isLogicNot,
  isLogicOr,
  isMatch,
  isMatchCase,
  isNatRec,
  isParamDecl,
  isParenthesisedExpr,
  isPred,
  isParenthesisedPattern,
  isPatternAsc,
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
  type Expr,
  type ParamDecl,
  type Pattern,
  type PatternBinding,
  type PatternVar,
  type Var,
} from "../generated/ast.js";


type ContextBinding = {
  name: string;
  typeText: string;
};

const UNKNOWN_TYPE_TEXT = "?";

const RULE_NAME_MAP: Record<string, string> = {
  Abstraction: "T-ABS",
  Application: "T-APP",
  ConstTrue: "T-TRUE",
  ConstFalse: "T-FALSE",
  ConstInt: "T-NAT",
  ConstUnit: "T-UNIT",
  If: "T-IF",
  Let: "T-LET",
  LetRec: "T-LETREC",
  Match: "T-MATCH",
  MatchCase: "T-CASE",
  NatRec: "T-NATREC",
  ParenthesisedExpr: "T-PARENS",
  Pred: "T-PRED",
  Succ: "T-SUCC",
  IsZero: "T-ISZERO",
  TypeAsc: "T-ASCRIBE",
  Add: "T-ADD",
  Subtraction: "T-SUB",
  Multiply: "T-MUL",
  Divide: "T-DIV",
  LogicAnd: "T-AND",
  LogicOr: "T-OR",
  LogicNot: "T-NOT",
  Equal: "T-EQ",
  NotEqual: "T-NEQ",
  LessThan: "T-LT",
  LessThanOrEqual: "T-LE",
  GreaterThan: "T-GT",
  GreaterThanOrEqual: "T-GE",
  Sequence: "T-SEQ",
  Ref: "T-REF",
  Deref: "T-DEREF",
  Assign: "T-ASSIGN",
  Var: "T-VAR",
};

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

function resolveExpressionNode(node: AstNode | undefined): Expr | undefined {
  let current = node;
  while (current) {
    if (isExpr(current)) {
      return current;
    }
    current = current.$container;
  }
  return undefined;
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
    // ignore inference errors: visualization should stay available
  }

  return undefined;
}

function asDisplayType(typeText: string | undefined): string {
  const normalized = typeText ? normalizeText(typeText) : undefined;
  if (!normalized || normalized.toLowerCase() === UNKNOWN_TYPE_TEXT) {
    return UNKNOWN_TYPE_TEXT;
  }
  return normalized;
}

function unwrapReferenceType(typeText: string | undefined): string | undefined {
  if (!typeText) {
    return undefined;
  }

  const normalized = normalizeText(typeText);
  if (normalized.startsWith("&")) {
    return normalized.slice(1).trim() || undefined;
  }

  const refMatch = normalized.match(/^Ref\((.+)\)$/i);
  return refMatch?.[1]?.trim();
}

function getVarName(node: Var): string {
  const referenced = node.ref.ref as { name?: string } | undefined;
  return referenced?.name ?? node.ref.$refText ?? "?";
}

function getParamTypeText(param: ParamDecl, services: StellaServices): string {
  return asDisplayType(getNodeText(param.paramType) ?? inferTypeText(param, services));
}

function getFunctionTypeText(
  declaration: Decl,
  services: StellaServices
): string | undefined {
  if (!isDeclFun(declaration) && !isDeclFunGeneric(declaration)) {
    return inferTypeText(declaration, services);
  }

  const params = declaration.paramDecls.map((param) => getParamTypeText(param, services));
  const returnType = asDisplayType(
    (declaration.returnType ? getNodeText(declaration.returnType) : undefined) ??
    inferTypeText(declaration.returnExpr, services)
  );

  if (params.length === 1) {
    return `${params[0]} -> ${returnType}`;
  }

  return `fn(${params.join(", ")}) -> ${returnType}`;
}

function getBindingTypeText(node: AstNode, services: StellaServices): string {
  if (isParamDecl(node)) {
    return getParamTypeText(node, services);
  }

  if (isDeclFun(node) || isDeclFunGeneric(node)) {
    return asDisplayType(getFunctionTypeText(node, services));
  }

  if (isDeclExceptionType(node)) {
    return asDisplayType(getNodeText(node.exceptionType));
  }

  if (isDeclExceptionVariant(node)) {
    return asDisplayType(getNodeText(node.variantType));
  }

  return asDisplayType(inferTypeText(node, services) ?? getNodeText(node));
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

function getPatternBindingNames(binding: PatternBinding): string[] {
  return collectPatternVars(binding.pattern).map((entry) => entry.name);
}

function addContextBinding(target: ContextBinding[], binding: ContextBinding): void {
  const existingIndex = target.findIndex((entry) => entry.name === binding.name);
  if (existingIndex >= 0) {
    target[existingIndex] = binding;
    return;
  }

  target.push(binding);
}

function addDeclarationBindings(
  target: ContextBinding[],
  declarations: Decl[],
  services: StellaServices,
  activePosition: AnalysisPosition,
  respectOrder: boolean
): void {
  for (const declaration of declarations) {
    if (respectOrder && !startsBeforeOrAt(getNodeRange(declaration), activePosition)) {
      continue;
    }

    if (isDeclFun(declaration) || isDeclFunGeneric(declaration)) {
      addContextBinding(target, {
        name: declaration.name,
        typeText: asDisplayType(getFunctionTypeText(declaration, services)),
      });
    }
  }
}

function addPatternBindings(
  target: ContextBinding[],
  pattern: Pattern,
  services: StellaServices
): void {
  for (const patternVar of collectPatternVars(pattern)) {
    addContextBinding(target, {
      name: patternVar.name,
      typeText: asDisplayType(inferTypeText(patternVar, services) ?? getNodeText(patternVar)),
    });
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

function collectAvailableContext(
  node: AstNode,
  services: StellaServices,
  activePosition: AnalysisPosition
): ContextBinding[] {
  const context: ContextBinding[] = [];

  for (const ancestor of getAncestors(node)) {
    if (isProgram(ancestor)) {
      addDeclarationBindings(context, ancestor.decls, services, activePosition, false);
      continue;
    }

    if (isDeclFun(ancestor) || isDeclFunGeneric(ancestor) || isAbstraction(ancestor)) {
      for (const param of ancestor.paramDecls) {
        addContextBinding(context, {
          name: param.name,
          typeText: getParamTypeText(param, services),
        });
      }

      if (isDeclFun(ancestor) || isDeclFunGeneric(ancestor)) {
        addDeclarationBindings(context, ancestor.localDecls, services, activePosition, true);
      }

      continue;
    }

    if (isLet(ancestor) && isSameOrDescendant(node, ancestor.body)) {
      for (const binding of ancestor.patternBindings) {
        addPatternBindings(context, binding.pattern, services);
      }
      continue;
    }

    if (isLetRec(ancestor)) {
      for (const binding of ancestor.patternBindings) {
        addPatternBindings(context, binding.pattern, services);
      }
      continue;
    }

    if (isMatchCase(ancestor) && isSameOrDescendant(node, ancestor.expr)) {
      addPatternBindings(context, ancestor.pattern, services);
      continue;
    }

    if (isTryCatch(ancestor) && isSameOrDescendant(node, ancestor.fallbackExpr)) {
      addPatternBindings(context, ancestor.pattern, services);
      continue;
    }

    if (isTryCastAs(ancestor) && isSameOrDescendant(node, ancestor.expr)) {
      addPatternBindings(context, ancestor.pattern, services);
    }
  }

  return context;
}

function getExprChildren(node: AstNode): Expr[] {
  const children: Expr[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object" && isExpr(entry)) {
          children.push(entry);
        }
      }
      continue;
    }

    if (value && typeof value === "object" && isExpr(value)) {
      children.push(value);
    }
  }

  return children;
}

function addAll(target: Set<string>, source: Iterable<string>): void {
  for (const entry of source) {
    target.add(entry);
  }
}

function subtract(source: Set<string>, names: Iterable<string>): Set<string> {
  const copy = new Set(source);
  for (const name of names) {
    copy.delete(name);
  }
  return copy;
}

function collectFreeVars(node: Expr): Set<string> {
  if (isVar(node)) {
    return new Set([getVarName(node)]);
  }

  if (isConstTrue(node) || isConstFalse(node) || isConstInt(node) || isConstUnit(node)) {
    return new Set();
  }

  if (isParenthesisedExpr(node)) {
    return collectFreeVars(node.expr);
  }

  if (isAbstraction(node)) {
    const freeInBody = collectFreeVars(node.returnExpr);
    return subtract(
      freeInBody,
      node.paramDecls.map((param) => param.name)
    );
  }

  if (isLet(node)) {
    const result = new Set<string>();
    for (const binding of node.patternBindings) {
      addAll(result, collectFreeVars(binding.rhs));
    }

    const bodyVars = collectFreeVars(node.body);
    const boundNames = node.patternBindings.flatMap((binding) => getPatternBindingNames(binding));
    addAll(result, subtract(bodyVars, boundNames));
    return result;
  }

  if (isLetRec(node)) {
    const boundNames = node.patternBindings.flatMap((binding) => getPatternBindingNames(binding));
    const result = new Set<string>();

    for (const binding of node.patternBindings) {
      addAll(result, subtract(collectFreeVars(binding.rhs), boundNames));
    }

    addAll(result, subtract(collectFreeVars(node.body), boundNames));
    return result;
  }

  if (isMatch(node)) {
    const result = collectFreeVars(node.expr);

    for (const matchCase of node.cases) {
      const caseVars = collectFreeVars(matchCase.expr);
      const patternNames = collectPatternVars(matchCase.pattern).map((entry) => entry.name);
      addAll(result, subtract(caseVars, patternNames));
    }

    return result;
  }

  const result = new Set<string>();
  for (const child of getExprChildren(node)) {
    addAll(result, collectFreeVars(child));
  }
  return result;
}

function filterContextForNode(node: Expr, availableContext: ContextBinding[]): ContextBinding[] {
  const freeVars = collectFreeVars(node);
  if (freeVars.size === 0) {
    return [];
  }

  return availableContext.filter((binding) => freeVars.has(binding.name));
}

function contextToText(context: ContextBinding[]): string {
  if (context.length === 0) {
    return "∅";
  }

  return context.map((entry) => `${entry.name}:${entry.typeText}`).join(", ");
}

function makeJudgement(
  context: ContextBinding[],
  expressionText: string,
  typeText: string
): string {
  const contextText = contextToText(context);
  if (contextText === "∅") {
    return `⊢ ${expressionText} : ${typeText}`;
  }

  return `${contextText} ⊢ ${expressionText} : ${typeText}`;
}

function createNode(
  sourceNode: AstNode,
  ruleName: string,
  displayedContext: ContextBinding[],
  expressionText: string,
  typeText: string,
  premises: TypeDerivationNode[] = []
): TypeDerivationNode {
  return {
    id: buildAstNodeId(sourceNode),
    ruleName,
    premises,
    conclusion: makeJudgement(displayedContext, expressionText, typeText),
    range: getNodeRange(sourceNode),
    expressionText,
    typeText,
    contextText: contextToText(displayedContext),
  };
}

function parseReturnType(functionTypeText: string | undefined): string | undefined {
  if (!functionTypeText) {
    return undefined;
  }

  const fnMatch = functionTypeText.match(/^\s*(?:\[[^\]]+\]\s*)?fn\((.*)\)\s*->\s*(.+)$/);
  if (fnMatch) {
    return fnMatch[2].trim();
  }

  const arrowIndex = functionTypeText.lastIndexOf("->");
  if (arrowIndex >= 0) {
    return functionTypeText.slice(arrowIndex + 2).trim();
  }

  return undefined;
}

function getRuleName(node: AstNode): string {
  return RULE_NAME_MAP[node.$type] ?? `T-${node.$type.toUpperCase()}`;
}

function maybeWrap(text: string, needed: boolean): string {
  return needed ? `(${text})` : text;
}

function formatPattern(pattern: Pattern): string {
  return getNodeText(pattern) ?? pattern.$type;
}

function formatExpr(node: Expr): string {
  if (isVar(node)) {
    return getVarName(node);
  }

  if (isConstTrue(node)) {
    return "true";
  }

  if (isConstFalse(node)) {
    return "false";
  }

  if (isConstInt(node) || isConstUnit(node)) {
    return getNodeText(node) ?? node.$type;
  }

  if (isParenthesisedExpr(node)) {
    return `(${formatExpr(node.expr)})`;
  }

  if (isAbstraction(node)) {
    const params = node.paramDecls
      .map((param) => `${param.name}:${getNodeText(param.paramType) ?? "?"}`)
      .join(", ");
    return `λ${params}. ${formatExpr(node.returnExpr)}`;
  }

  if (isApplication(node)) {
    const funText = formatExpr(node.fun);
    const argsText = node.args.map((arg) => maybeWrap(formatExpr(arg), isApplication(arg) || isAbstraction(arg))).join(" ");
    return `${maybeWrap(funText, isAbstraction(node.fun))}${argsText ? ` ${argsText}` : ""}`;
  }

  if (isIf(node)) {
    return `if ${formatExpr(node.condition)} then ${formatExpr(node.thenExpr)} else ${formatExpr(node.elseExpr)}`;
  }

  if (isNatRec(node)) {
    return `Nat::rec(${formatExpr(node.n)}, ${formatExpr(node.initial)}, ${formatExpr(node.step)})`;
  }

  if (isLet(node)) {
    const bindings = node.patternBindings
      .map((binding) => `${formatPattern(binding.pattern)} = ${formatExpr(binding.rhs)}`)
      .join(", ");
    return `let ${bindings} in ${formatExpr(node.body)}`;
  }

  if (isLetRec(node)) {
    const bindings = node.patternBindings
      .map((binding) => `${formatPattern(binding.pattern)} = ${formatExpr(binding.rhs)}`)
      .join(", ");
    return `letrec ${bindings} in ${formatExpr(node.body)}`;
  }

  if (isTypeAsc(node)) {
    return `${formatExpr(node.expr)} : ${getNodeText(node.type) ?? "?"}`;
  }

  const text = getNodeText(node);
  if (text) {
    return text;
  }

  return node.$type;
}

function buildGenericPremises(
  node: Expr,
  availableContext: ContextBinding[],
  services: StellaServices
): TypeDerivationNode[] {
  return getExprChildren(node).map((child) => buildDerivation(child, availableContext, services));
}

function deriveAbstractionType(
  node: Expr,
  services: StellaServices,
  fallbackBodyType?: string
): string {
  if (!isAbstraction(node)) {
    return asDisplayType(inferTypeText(node, services));
  }

  const paramTypes = node.paramDecls.map((param) => getParamTypeText(param, services));
  const bodyType = asDisplayType(fallbackBodyType ?? inferTypeText(node.returnExpr, services));

  if (paramTypes.length === 1) {
    return `${paramTypes[0]} -> ${bodyType}`;
  }

  return `fn(${paramTypes.join(", ")}) -> ${bodyType}`;
}

function deriveApplicationType(
  node: Expr,
  services: StellaServices,
  funTypeText?: string
): string {
  if (isApplication(node)) {
    const direct = inferTypeText(node, services);
    if (direct) {
      return direct;
    }

    const returnType = parseReturnType(funTypeText);
    if (returnType) {
      return returnType;
    }
  }

  return asDisplayType(inferTypeText(node, services));
}

function determineDerivedType(
  node: Expr,
  premises: TypeDerivationNode[],
  services: StellaServices
): string {
  const inferred = inferTypeText(node, services);
  if (inferred) {
    return asDisplayType(inferred);
  }

  if (isTypeAsc(node)) {
    return asDisplayType(getNodeText(node.type));
  }

  if (isIf(node)) {
    return asDisplayType(premises[1]?.typeText ?? premises[2]?.typeText);
  }

  if (isLet(node) || isLetRec(node) || isMatch(node) || isTryCatch(node) || isTryWith(node) || isTryCastAs(node)) {
    return asDisplayType(premises[premises.length - 1]?.typeText);
  }

  if (isSequence(node)) {
    return asDisplayType(premises[1]?.typeText);
  }

  if (
    isAdd(node) ||
    isSubtraction(node) ||
    isMultiply(node) ||
    isDivide(node) ||
    isSucc(node) ||
    isPred(node) ||
    isNatRec(node)
  ) {
    return "Nat";
  }

  if (
    isLogicAnd(node) ||
    isLogicOr(node) ||
    isLogicNot(node) ||
    isIsZero(node) ||
    isEqual(node) ||
    isNotEqual(node) ||
    isLessThan(node) ||
    isLessThanOrEqual(node) ||
    isGreaterThan(node) ||
    isGreaterThanOrEqual(node)
  ) {
    return "Bool";
  }

  if (isApplication(node)) {
    return asDisplayType(parseReturnType(premises[0]?.typeText));
  }

  if (isRef(node)) {
    return asDisplayType(`&${premises[0]?.typeText ?? UNKNOWN_TYPE_TEXT}`);
  }

  if (isDeref(node)) {
    return asDisplayType(unwrapReferenceType(premises[0]?.typeText));
  }

  if (isAssign(node)) {
    return "Unit";
  }

  return asDisplayType(premises[premises.length - 1]?.typeText);
}

function buildDerivation(
  node: Expr,
  availableContext: ContextBinding[],
  services: StellaServices
): TypeDerivationNode {
  const displayedContext = filterContextForNode(node, availableContext);
  const expressionText = formatExpr(node);

  if (isVar(node)) {
    const target = node.ref.ref as AstNode | undefined;
    const typeText = target ? getBindingTypeText(target, services) : UNKNOWN_TYPE_TEXT;
    return createNode(node, "T-VAR", displayedContext, expressionText, typeText);
  }

  if (isConstTrue(node)) {
    return createNode(node, "T-TRUE", displayedContext, expressionText, "Bool");
  }

  if (isConstFalse(node)) {
    return createNode(node, "T-FALSE", displayedContext, expressionText, "Bool");
  }

  if (isConstInt(node)) {
    return createNode(node, "T-NAT", displayedContext, expressionText, "Nat");
  }

  if (isConstUnit(node)) {
    return createNode(node, "T-UNIT", displayedContext, expressionText, "Unit");
  }

  if (isParenthesisedExpr(node)) {
    const premise = buildDerivation(node.expr, availableContext, services);
    const typeText = asDisplayType(premise.typeText ?? inferTypeText(node.expr, services));
    return createNode(node, "T-PARENS", displayedContext, expressionText, typeText, [premise]);
  }

  if (isAbstraction(node)) {
    const extendedContext = [...availableContext];
    for (const param of node.paramDecls) {
      addContextBinding(extendedContext, {
        name: param.name,
        typeText: getParamTypeText(param, services),
      });
    }

    const bodyPremise = buildDerivation(node.returnExpr, extendedContext, services);
    const typeText = asDisplayType(deriveAbstractionType(node, services, bodyPremise.typeText));
    return createNode(node, "T-ABS", displayedContext, expressionText, typeText, [bodyPremise]);
  }

  if (isApplication(node)) {
    const funPremise = buildDerivation(node.fun, availableContext, services);
    const argPremises = node.args.map((arg) => buildDerivation(arg, availableContext, services));
    const typeText = asDisplayType(deriveApplicationType(node, services, funPremise.typeText));
    return createNode(node, "T-APP", displayedContext, expressionText, typeText, [
      funPremise,
      ...argPremises,
    ]);
  }

  if (isIf(node)) {
    const premises = [
      buildDerivation(node.condition, availableContext, services),
      buildDerivation(node.thenExpr, availableContext, services),
      buildDerivation(node.elseExpr, availableContext, services),
    ];
    const typeText = determineDerivedType(node, premises, services);
    return createNode(node, "T-IF", displayedContext, expressionText, typeText, premises);
  }

  if (isLet(node)) {
    const bindingPremises = node.patternBindings.map((binding) =>
      buildDerivation(binding.rhs, availableContext, services)
    );

    const extendedContext = [...availableContext];
    for (const binding of node.patternBindings) {
      addPatternBindings(extendedContext, binding.pattern, services);
    }

    const bodyPremise = buildDerivation(node.body, extendedContext, services);
    const typeText = determineDerivedType(node, [...bindingPremises, bodyPremise], services);
    return createNode(node, "T-LET", displayedContext, expressionText, typeText, [
      ...bindingPremises,
      bodyPremise,
    ]);
  }

  if (isLetRec(node)) {
    const extendedContext = [...availableContext];
    for (const binding of node.patternBindings) {
      addPatternBindings(extendedContext, binding.pattern, services);
    }

    const bindingPremises = node.patternBindings.map((binding) =>
      buildDerivation(binding.rhs, extendedContext, services)
    );
    const bodyPremise = buildDerivation(node.body, extendedContext, services);
    const typeText = determineDerivedType(node, [...bindingPremises, bodyPremise], services);
    return createNode(node, "T-LETREC", displayedContext, expressionText, typeText, [
      ...bindingPremises,
      bodyPremise,
    ]);
  }

  if (isMatch(node)) {
    const scrutineePremise = buildDerivation(node.expr, availableContext, services);
    const casePremises = node.cases.map((matchCase) => {
      const extendedContext = [...availableContext];
      addPatternBindings(extendedContext, matchCase.pattern, services);
      return buildDerivation(matchCase.expr, extendedContext, services);
    });

    const typeText = determineDerivedType(node, [scrutineePremise, ...casePremises], services);
    return createNode(node, "T-MATCH", displayedContext, expressionText, typeText, [
      scrutineePremise,
      ...casePremises,
    ]);
  }

  const premises = buildGenericPremises(node, availableContext, services);
  const typeText = determineDerivedType(node, premises, services);

  return createNode(node, getRuleName(node), displayedContext, expressionText, typeText, premises);
}

export function registerTypeDerivationRequest(
  connection: Connection,
  services: StellaServices
): void {
  connection.onRequest(
    STELLA_TYPE_DERIVATION_REQUEST,
    async (
      params: TypeDerivationRequestParams
    ): Promise<TypeDerivationRequestResult> => {
      const document = await resolveDocument(services, params.uri);
      const astNode = findAstNodeAtPosition(document, params.position);
      const expressionNode = resolveExpressionNode(astNode);

      if (!expressionNode) {
        return null;
      }

      const availableContext = collectAvailableContext(
        expressionNode,
        services,
        params.position
      );

      const view: TypeDerivationView = {
        documentUri: params.uri,
        root: buildDerivation(expressionNode, availableContext, services),
      };

      return view;
    }
  );
}
