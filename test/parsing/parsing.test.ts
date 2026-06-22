import { beforeAll, describe, expect, test } from "vitest";
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { expandToString as s } from "langium/generate";
import { parseHelper } from "langium/test";
import { createStellaServices } from "../../src/language/stella-module.js";
import {
    Program,
    isConstInt,
    isDeclFun,
    isProgram,
} from "../../src/language/generated/ast.js";

const VALID_PROGRAM = `
language core;

fn main() {
    return 0
}
`;

let services: ReturnType<typeof createStellaServices>;
let parse: ReturnType<typeof parseHelper<Program>>;
let document: LangiumDocument<Program> | undefined;

beforeAll(async () => {
    services = createStellaServices(EmptyFileSystem);
    parse = parseHelper<Program>(services.Stella);
});

describe("Parsing tests", () => {
    test("parse simple Stella program", async () => {
        document = await parse(VALID_PROGRAM);

        expect(checkDocumentValid(document)).toBeUndefined();

        const program = document.parseResult.value;
        expect(program.extensions).toHaveLength(0);
        expect(program.decls).toHaveLength(1);

        const main = program.decls[0];
        expect(isDeclFun(main)).toBe(true);

        if (!isDeclFun(main)) {
            throw new Error("Expected first declaration to be a function.");
        }

        expect(main.name).toBe("main");
        expect(isConstInt(main.returnExpr)).toBe(true);

        if (isConstInt(main.returnExpr)) {
            expect(main.returnExpr.n).toBe(0);
        }
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
