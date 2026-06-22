import { AstNode, CstUtils, type LangiumDocument, URI } from "langium";
import { isType } from "typir";
import { Connection } from "vscode-languageserver/node.js";
import type {
  AnalysisPosition,
  AnalysisRange,
} from "../../shared/analysis/analysis-types.js";
import type {
  TypeErrorTraceDiagnosticView,
  TypeErrorTraceNode,
  TypeErrorTraceView,
} from "../../shared/analysis/type-error-trace-types.js";
import {
  STELLA_TYPE_ERROR_TRACE_REQUEST,
  type TypeErrorTraceRequestParams,
  type TypeErrorTraceRequestResult,
} from "../../shared/lsp/type-error-trace-protocol.js";
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
  // isDeclExceptionType,
  // isDeclExceptionVariant,
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
  isMatchCase,
  isMultiply,
  isNatRec,
  isNotEqual,
  // isParamDecl,
  isParenthesisedExpr,
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
  isPred,
  isProgram,
  isRef,
  isSequence,
  isSubtraction,
  isSucc,
  isTryCastAs,
  isTryCatch,
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

const RULE_NAME_MAP: Record<string, string> = {
  Abstraction: "T-ABS",
  Add: "T-ADD",
  Application: "T-APP",
  Assign: "T-ASSIGN",
  ConstFalse: "T-FALSE",
  ConstInt: "T-NAT",
  ConstTrue: "T-TRUE",
  ConstUnit: "T-UNIT",
  Deref: "T-DEREF",
  Divide: "T-DIV",
  Equal: "T-EQ",
  GreaterThan: "T-GT",
  GreaterThanOrEqual: "T-GE",
  If: "T-IF",
  IsZero: "T-ISZERO",
  LessThan: "T-LT",
  LessThanOrEqual: "T-LE",
  Let: "T-LET",
  LetRec: "T-LETREC",
  LogicAnd: "T-AND",
  LogicNot: "T-NOT",
  LogicOr: "T-OR",
  Match: "T-MATCH",
  Multiply: "T-MUL",
  NatRec: "T-NATREC",
  NotEqual: "T-NEQ",
  ParenthesisedExpr: "T-PARENS",
  Pred: "T-PRED",
  Ref: "T-REF",
  Sequence: "T-SEQ",
  Subtraction: "T-SUB",
  Succ: "T-SUCC",
  TypeAsc: "T-ASCRIBE",
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
    // keep visualization available even when inference fails
  }

  return undefined;
}

function getVarName(node: Var): string {
  const referenced = node.ref.ref as { name?: string } | undefined;
  return referenced?.name ?? node.ref.$refText ?? "?";
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
        typeText: getFunctionTypeText(declaration, services) ?? "unknown",
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
      typeText: inferTypeText(patternVar, services) ?? "unknown",
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
    const argsText = node.args
      .map((arg) => maybeWrap(formatExpr(arg), isApplication(arg) || isAbstraction(arg)))
      .join(" ");
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

  return getNodeText(node) ?? node.$type;
}

function parseDiagnostic(message: string, range?: AnalysisRange): TypeErrorTraceDiagnosticView {
  const trimmed = normalizeText(message);
  const result: TypeErrorTraceDiagnosticView = {
    message: trimmed,
    range,
  };

  const returnMismatch = trimmed.match(
    /The return type of function\s+(.+?)\s+is\s+(.+?),\s+but the declared return type is\s+(.+)$/i
  );
  if (returnMismatch) {
    result.actualType = returnMismatch[2].trim();
    result.expectedType = returnMismatch[3].trim();
    return result;
  }

  const expectedFound = trimmed.match(/expected\s+(.+?)\s+but\s+(?:got|found)\s+(.+)$/i);
  if (expectedFound) {
    result.expectedType = expectedFound[1].trim();
    result.actualType = expectedFound[2].trim();
    return result;
  }

  const actualExpected = trimmed.match(/actual\s+type\s+(.+?),\s*expected\s+(.+)$/i);
  if (actualExpected) {
    result.actualType = actualExpected[1].trim();
    result.expectedType = actualExpected[2].trim();
  }

  return result;
}

function formatDiagnosticSummary(diagnostic: TypeErrorTraceDiagnosticView): string {
  if (diagnostic.expectedType && diagnostic.actualType) {
    return `expected ${diagnostic.expectedType}, got ${diagnostic.actualType}`;
  }

  return diagnostic.message;
}

function findEnclosingReturnDeclaration(
  node: AstNode
): Decl | undefined {
  let current: AstNode | undefined = node;
  while (current) {
    if (
      (isDeclFun(current) || isDeclFunGeneric(current)) &&
      isSameOrDescendant(node, current.returnExpr)
    ) {
      return current;
    }
    current = current.$container;
  }
  return undefined;
}

function getExpressionAncestorPath(node: Expr): Expr[] {
  const path: Expr[] = [];
  let current: AstNode | undefined = node;

  while (current) {
    if (isExpr(current)) {
      path.unshift(current);
    }
    current = current.$container;
  }

  return path;
}

function relationDetail(parent: Expr, child: Expr): string | undefined {
  if (isApplication(parent)) {
    if (child === parent.fun) {
      return "Сначала нужно вывести тип функции в позиции применения.";
    }

    if (parent.args.includes(child)) {
      return "Затем проверяется аргумент применения и его совместимость с параметром функции.";
    }
  }

  if (isIf(parent)) {
    if (child === parent.condition) {
      return "Условие if должно иметь тип Bool.";
    }
    if (child === parent.thenExpr || child === parent.elseExpr) {
      return "Обе ветви if должны иметь совместимые типы.";
    }
  }

  if (isLet(parent)) {
    if (child === parent.body) {
      return "После проверки связываний тип тела let выводится в расширенном контексте.";
    }
    return "Сначала вычисляется тип правой части связывания let.";
  }

  if (isLetRec(parent)) {
    if (child === parent.body) {
      return "Тело letrec проверяется после добавления рекурсивных связываний в контекст.";
    }
    return "Правая часть рекурсивного связывания проверяется в уже расширенном контексте.";
  }

  if (isMatch(parent)) {
    if (child === parent.expr) {
      return "Сначала проверяется выражение, по которому выполняется сопоставление.";
    }
    return "Каждая ветка match проверяется в контексте, расширенном переменными паттерна.";
  }

  if (isNatRec(parent)) {
    if (child === parent.n) {
      return "Первый аргумент Nat::rec должен иметь тип Nat.";
    }
    if (child === parent.initial) {
      return "Второй аргумент Nat::rec задаёт базовый случай вычисления.";
    }
    if (child === parent.step) {
      return "Третий аргумент Nat::rec должен задавать корректный шаг рекурсии.";
    }
  }

  if (isTypeAsc(parent) && child === parent.expr) {
    return "Аннотированное выражение должно быть совместимо с явно указанным типом.";
  }

  if (isAssign(parent)) {
    return child === parent.left
      ? "Слева от присваивания должно быть ссылочное значение." 
      : "Тип правой части должен быть совместим с типом ссылки слева.";
  }

  if (isRef(parent) && child === parent.expr) {
    return "Тип ссылки строится из типа вложенного выражения.";
  }

  if (isDeref(parent) && child === parent.expr) {
    return "Для разыменования требуется выражение ссылочного типа.";
  }

  if (isSequence(parent)) {
    return "В последовательности ошибка может приходить из любого из подвыражений по порядку вычисления.";
  }

  if (
    isAdd(parent) ||
    isSubtraction(parent) ||
    isMultiply(parent) ||
    isDivide(parent) ||
    isLessThan(parent) ||
    isLessThanOrEqual(parent) ||
    isGreaterThan(parent) ||
    isGreaterThanOrEqual(parent) ||
    isEqual(parent) ||
    isNotEqual(parent)
  ) {
    return "Бинарный оператор требует, чтобы типы его операндов удовлетворяли правилу этого оператора.";
  }

  if (isLogicAnd(parent) || isLogicOr(parent)) {
    return "Логический оператор ожидает булевы операнды.";
  }

  if (isLogicNot(parent) || isSucc(parent) || isPred(parent) || isIsZero(parent)) {
    return "Тип внешнего выражения определяется по типу его единственного подвыражения.";
  }

  return `Ошибка проявляется внутри подвыражения правила ${getRuleName(child)}.`;
}

function createTraceNode(
  sourceNode: AstNode,
  displayedContext: ContextBinding[],
  detail: string | undefined,
  services: StellaServices,
  children: TypeErrorTraceNode[] = [],
  isFocused = false,
  isErrorSource = false
): TypeErrorTraceNode {
  const typeText = inferTypeText(sourceNode, services) ?? "unknown";
  const expressionText = isExpr(sourceNode) ? formatExpr(sourceNode) : getNodeText(sourceNode) ?? sourceNode.$type;

  return {
    id: buildAstNodeId(sourceNode),
    ruleName: getRuleName(sourceNode),
    judgement: makeJudgement(displayedContext, expressionText, typeText),
    detail,
    range: getNodeRange(sourceNode),
    isFocused,
    isErrorSource,
    children,
  };
}

function buildTraceChain(
  path: Expr[],
  index: number,
  availableContext: ContextBinding[],
  services: StellaServices,
  diagnostic: TypeErrorTraceDiagnosticView
): TypeErrorTraceNode {
  const current = path[index];
  const displayedContext = filterContextForNode(current, availableContext);
  const isLeaf = index === path.length - 1;

  if (isLeaf) {
    return createTraceNode(
      current,
      displayedContext,
      `Точка ошибки: ${formatDiagnosticSummary(diagnostic)}`,
      services,
      [],
      true,
      true
    );
  }

  const child = buildTraceChain(path, index + 1, availableContext, services, diagnostic);
  return createTraceNode(
    current,
    displayedContext,
    relationDetail(current, path[index + 1]),
    services,
    [child],
    index === path.length - 1,
    false
  );
}

function maybeWrapWithReturnContract(
  node: Expr,
  root: TypeErrorTraceNode,
  diagnostic: TypeErrorTraceDiagnosticView,
  services: StellaServices
): TypeErrorTraceNode {
  const enclosingDecl = findEnclosingReturnDeclaration(node);
  if (!enclosingDecl || (!diagnostic.expectedType && !diagnostic.actualType)) {
    return root;
  }

  const functionName = isDeclFun(enclosingDecl) || isDeclFunGeneric(enclosingDecl)
    ? enclosingDecl.name
    : "function";
  const declaredReturnType =
    (isDeclFun(enclosingDecl) || isDeclFunGeneric(enclosingDecl)) && enclosingDecl.returnType
      ? getNodeText(enclosingDecl.returnType)
      : diagnostic.expectedType ?? "unknown";

  return {
    id: `${buildAstNodeId(enclosingDecl)}:return-check`,
    ruleName: "RETURN-CHECK",
    judgement: `${functionName} : return ${declaredReturnType ?? "unknown"}`,
    detail: `Контракт функции требует тип ${diagnostic.expectedType ?? declaredReturnType ?? "unknown"}, но вычисленная ветка приводит к ${diagnostic.actualType ?? "unknown"}.`,
    range: getNodeRange(enclosingDecl),
    children: [root],
  };
}

export function registerTypeErrorTraceRequest(
  connection: Connection,
  services: StellaServices
): void {
  connection.onRequest(
    STELLA_TYPE_ERROR_TRACE_REQUEST,
    async (
      params: TypeErrorTraceRequestParams
    ): Promise<TypeErrorTraceRequestResult> => {
      const document = await resolveDocument(services, params.uri);
      const tracePosition = params.diagnostic?.range?.start ?? params.position;
      const astNode = findAstNodeAtPosition(document, tracePosition);
      const expressionNode = resolveExpressionNode(astNode);

      if (!expressionNode) {
        return null;
      }

      const availableContext = collectAvailableContext(
        expressionNode,
        services,
        params.position
      );

      const diagnostic = parseDiagnostic(
        params.diagnostic?.message ?? "Type error",
        params.diagnostic?.range
      );

      const path = getExpressionAncestorPath(expressionNode);
      const root = maybeWrapWithReturnContract(
        expressionNode,
        buildTraceChain(path, 0, availableContext, services, diagnostic),
        diagnostic,
        services
      );

      const view: TypeErrorTraceView = {
        documentUri: params.uri,
        diagnostic,
        root,
      };

      return view;
    }
  );
}
