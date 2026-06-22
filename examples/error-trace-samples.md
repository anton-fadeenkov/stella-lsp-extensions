# Stella error trace samples

## 1. Return type mismatch

```stella
language core;

extend with
  #natural-literals;

fn badReturn(n : Nat) -> Bool {
  return succ(n)
}
```

Expected behavior:
- The editor shows a type diagnostic on `succ(n)` or on the function body.
- **Type Error Trace** should build a short chain like:
  - `RETURN-CHECK` — function declared `Bool`
  - `T-SUCC` — `succ(n)` has type `Nat`
  - `T-VAR` — `n : Nat`
- The top card should show a short readable message such as: `Type mismatch: expected Bool, got Nat.`

## 2. If branches mismatch

```stella
language core;

fn badIf(flag : Bool) -> Nat {
  return if flag then 0 else false
}
```

Expected behavior:
- The trace should show:
  - `RETURN-CHECK` or `T-IF`
  - `T-IF` — both branches must have compatible types
  - one child for the condition (`T-VAR` / `T-TRUE` / `T-FALSE`)
  - one child for `0 : Nat`
  - one child for `false : Bool`
- The explanation under `T-IF` should say that both branches must be type-compatible.

## 3. Function application mismatch

```stella
language core;

fn takesNat(x : Nat) -> Nat {
  return succ(x)
}

fn main(flag : Bool) -> Nat {
  return takesNat(flag)
}
```

Expected behavior:
- The trace should follow application checking:
  - `RETURN-CHECK` or `T-APP`
  - `T-APP` — function type is checked first
  - child 1: `takesNat : Nat -> Nat`
  - child 2: `flag : Bool`
- The detail should explain that the argument type must match the function parameter type.

## 4. Syntax error example that should NOT open a noisy trace

```stella
language core;

fn broken(n : Nat) -> Nat {
  return succ(n
}
```

Expected behavior:
- The parser may still show a syntax diagnostic in Problems.
- **Type Error Trace** should not display the long `Expecting: one of these possible Token sequences...` message.
- The panel should instead say that there is no suitable type diagnostic at the current cursor position.
