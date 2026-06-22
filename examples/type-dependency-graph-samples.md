# Type dependency graph test cases

Use these examples to validate the new **Type Dependency Graph** panel.

## 1. Function application mismatch

File: `examples/dependency-graph/application-mismatch.stella`

Expected graph behavior:
- selected expression: `takesNat(flag)`
- nodes for `takesNat`, `flag`, and the enclosing function `main`
- edge `flag -> takesNat(flag)` should be marked as a conflict because the function expects `Nat`, but `flag` has type `Bool`
- the enclosing function `main` should appear as context on the left, with an incoming relation to the selected return expression

## 2. Conditional branch mismatch

File: `examples/dependency-graph/if-branch-mismatch.stella`

Expected graph behavior:
- selected expression: `if flag then 0 else false`
- three incoming edges: `condition`, `then`, `else`
- `condition` is valid because it is `Bool`
- `then` / `else` should be highlighted as a conflict because branch types differ (`Nat` vs `Bool`)

## 3. Let-binding and arithmetic flow

File: `examples/dependency-graph/let-binding-flow.stella`

Expected graph behavior:
- selected expression: `x + y`
- nodes for the binding patterns `x` and `y`
- their values should feed into the binding nodes, and the binding nodes should feed into the arithmetic expression
- the enclosing function should appear as the return context for the final expression

## Suggested manual test flow in VS Code

1. Open one of the sample `.stella` files.
2. Place the cursor on the expression that should be analyzed.
3. Run `Stella: Show Type Dependency Graph`.
4. Verify that clicking graph nodes reveals the correct source fragment.
5. For the mismatch examples, check that conflict edges are red and the problematic nodes are highlighted.
