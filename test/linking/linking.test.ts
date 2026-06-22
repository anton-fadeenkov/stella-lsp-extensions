import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { expandToString as s } from "langium/generate";
import { clearDocuments, parseHelper } from "langium/test";
import { createStellaServices } from "../../src/language/stella-module.js";
import {
    Program,
    isApplication,
    isDeclFun,
    isProgram,
    isVar,
} from "../../src/language/generated/ast.js";

let services: ReturnType<typeof createStellaServices>;
let parse: ReturnType<typeof parseHelper<Program>>;
let document: LangiumDocument<Program> | undefined;

beforeAll(async () => {
    services = createStellaServices(EmptyFileSystem);
    parse = parseHelper<Program>(services.Stella);
});

afterEach(async () => {
    document && clearDocuments(services.shared, [document]);
});

describe("Linking tests", () => {
    test("links function calls to declarations", async () => {
        document = await parse(`
            language core;

            fn main() {
                return 0
            }

            fn caller() {
                return main()
            }
        `);

        expect(checkDocumentValid(document)).toBeUndefined();

        const caller = document.parseResult.value.decls.find(
            decl => isDeclFun(decl) && decl.name === "caller"
        );

        if (!isDeclFun(caller) || !isApplication(caller.returnExpr) || !isVar(caller.returnExpr.fun)) {
            throw new Error("Expected caller to return a direct call to main().");
        }

        expect(caller.returnExpr.fun.ref.ref?.name || caller.returnExpr.fun.ref.error?.message)
            .toBe("main");
    });
});

function checkDocumentValid(document: LangiumDocument): string | undefined {
    return document.parseResult.parserErrors.length && s`
        Parser errors:
          ${document.parseResult.parserErrors.map(e => e.message).join("\n  ")}
    `
        || document.parseResult.value === undefined && "ParseResult is 'undefined'."
        || !isProgram(document.parseResult.value) && `Root AST object is a ${document.parseResult.value.$type}, expected a '${Program.$type}'.`
        || undefined;
}
