import type { AstNode } from "langium";
import { NO_PARAMETER_NAME, InferenceRuleNotApplicable } from "typir";
import type {
  LangiumTypeSystemDefinition,
  TypirLangiumServices,
  TypirLangiumSpecifics,
} from "typir-langium";
import {
  type StellaAstType,
  isDeclFun,
  isVar,
  Var,
  ConstInt,
  ConstTrue,
  ConstFalse,
  // TypeUnit,
  TypeAuto,
  TypeTop,
  TypeBottom,
  If,
  Succ,
  IsZero,
  Deref,
  Application,
  DeclFun,
  TypeNat,
  TypeBool,
  // ConstUnit,
} from "../generated/ast.js";

export interface StellaSpecifics extends TypirLangiumSpecifics {
  AstTypes: StellaAstType; // all AST types from the generated `ast.ts`
}

export type TypirStellaServices = TypirLangiumServices<StellaSpecifics>;

export class StellaTypeSystem
  implements LangiumTypeSystemDefinition<StellaSpecifics>
{
  onInitialize(typir: TypirStellaServices): void {
    // Register primitive types
    const typeNat = typir.factory.Primitives.create({
      // The name here doesn't have to correspond to the name in the grammar, what matters is the inference rule
      primitiveName: "Nat",
    })
      .inferenceRule({ languageKey: ConstInt.$type })
      .inferenceRule({ languageKey: TypeNat.$type }) // I don't like that "Nat" has type "Nat", but not sure what's it supposed to be
      .finish();

    const typeBool = typir.factory.Primitives.create({
      primitiveName: "Bool",
    })
      .inferenceRule({ languageKey: [ConstTrue.$type, ConstFalse.$type] })
      .inferenceRule({ languageKey: TypeBool.$type })
      .finish();

    // const typeUnit = typir.factory.Primitives.create({ primitiveName: "Unit" })
    //   .inferenceRule({ languageKey: ConstUnit.$type })
    //   .inferenceRule({ languageKey: TypeUnit.$type })
    //   .finish();

    // TODO: is auto really a "primitive" type? Is there a distinction between primitive and built-in types in Typir?
    const typeAuto = typir.factory.Primitives.create({
      primitiveName: "auto",
    })
      .inferenceRule({ languageKey: TypeAuto.$type })
      .finish();

    // Top and bottom
    // TODO: I'm probably using inference rules incorrectly ??
    const typeTop = typir.factory.Top.create({})
      .inferenceRule({ languageKey: TypeTop.$type })
      .finish();

    const typeBottom = typir.factory.Bottom.create({})
      .inferenceRule({ languageKey: TypeBottom.$type })
      .finish();

    // Unary operators
    // TODO: also needs generics
    typir.factory.Operators.createUnary({
      name: "Dereference",
      signature: {
        operand: typeAuto, // TODO: generics are not yet supported in Typir :(
        return: typeBottom,
      },
    })
      .inferenceRule<Deref>({
        languageKey: Deref.$type,
        matching: () => true,
        // The type of a dereference is the type of the variable it points to
        operand: (deref) => deref.expr,
      })
      .finish();

    // Binary operators
    typir.factory.Operators.createBinary;

    // Ternary operators
    typir.factory.Operators.createTernary({
      name: "If-then-else",
      signature: {
        first: typeBool,
        second: typeTop, // TODO: generics are not yet supported in Typir :(
        third: typeTop,
        return: typeTop,
      },
    })
      .inferenceRule<If>({
        languageKey: If.$type,
        matching: () => true,
        operands: (node) => [node.condition, node.thenExpr, node.elseExpr],
      })
      .finish();

    // Built-in functions
    typir.factory.Functions.create({
      functionName: "succ",
      inputParameters: [{ name: "n", type: typeNat }],
      outputParameter: {
        name: NO_PARAMETER_NAME,
        type: typeNat,
      },
    })
      .inferenceRuleForCalls<Succ>({
        languageKey: Succ.$type,
        inputArguments: (node) => [node.n],
      })
      .finish();

    typir.factory.Functions.create({
      functionName: "Nat::iszero",
      inputParameters: [{ name: "n", type: typeNat }],
      outputParameter: {
        name: NO_PARAMETER_NAME,
        type: typeBool,
      },
    }).inferenceRuleForCalls<IsZero>({
      languageKey: IsZero.$type,
      inputArguments: (node) => [node.n],
    });

    // TODO: "List::" functions (and the type itself) depend on Typir adding generics

    // Inference rules
    typir.Inference.addInferenceRulesForAstNodes({
      Var: (node) => node.ref.ref ?? InferenceRuleNotApplicable, // The type of a variable is the type of the declaration it points to
      Application: (node) => {
        if (isVar(node.fun)) {
          const decl = node.fun.ref.ref as DeclFun | undefined;
          return decl?.returnType ?? InferenceRuleNotApplicable;
        }
        return InferenceRuleNotApplicable;
      },
      ParamDecl: (node) => node.paramType,
    });

    // Additional validations
    // Return of a function must match the declared return type
    typir.validation.Collector.addValidationRulesForAstNodes({
      DeclFun: (node, accept, typir) => {
        return typir.validation.Constraints.ensureNodeIsAssignable(
          node.returnExpr,
          node.returnType,
          accept,
          (actual, expected) => ({
            message: `The return type of function ${node.name} is ${actual.userRepresentation}, but the declared return type is ${expected.userRepresentation}`,
          })
        );
      },
    });
  }

  onNewAstNode(node: AstNode, typir: TypirStellaServices): void {
    if (isDeclFun(node)) {
      typir.factory.Functions.create({
        functionName: node.name,
        inputParameters: node.paramDecls.map((decl) => ({
          name: decl.name,
          type: decl.paramType,
        })),
        outputParameter: {
          name: NO_PARAMETER_NAME,
          type: node.returnType!,
        },
        associatedLanguageNode: node,
      })
        .inferenceRuleForDeclaration({
          matching: (otherNode) => otherNode === node, // only the current function/method declaration matches
        })
        .inferenceRuleForCalls<Application>({
          languageKey: Application.$type,
          matching: (application) => {
            return (application.fun as Var)?.ref?.ref === node; // TODO: check what any expression evaluates to
          },
          inputArguments: (application) => application.args,
        });
    }
  }
}
