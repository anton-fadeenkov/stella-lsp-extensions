# Stella language server

VS Code extension and language server for the [Stella language](https://fizruk.github.io/stella) with visual analysis tools for education and debugging.

## Features

- Syntax highlighting, including inside markdown fenced blocks
- Semantic highlighting
- Code snippets
- Go to definition
- AST viewer synchronized with the editor cursor
- Scope / context (`Γ`) viewer with real bindings and inferred types from the language server
- Interactive type derivation tree for the selected expression
- Reverse trace for type errors with clickable source fragments
- Type dependency graph for the selected function or expression

![AST view](./images/ast-view.png)

## Commands

- `Stella: Show AST (JSON)`
- `Stella: Show Type Derivation`
- `Stella: Show Type Error Trace`
- `Stella: Show Type Dependency Graph`
- `Stella: Refresh Syntax Tree`

## Notes

The extension exposes custom LSP requests for AST, scope/context, type derivation, reverse type-error tracing, and a type dependency graph. These views are intended to support both development and teaching scenarios.
