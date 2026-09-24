import { Decimal } from "@keka/shared";

/**
 * Salary component formula engine.
 *
 * Syntax matches the documented bracket notation: component codes go in
 * square brackets, arithmetic follows BODMAS, and nested IF is supported.
 *
 *   [BASIC] * 0.12
 *   [CTC_ANNUAL] / 2920
 *   IF([BASIC] > 15000, 1800, [BASIC] * 0.12)
 *   MIN([BASIC] * 0.5, 100000)
 *   IF(AND([BASIC] > 10000, [GROSS] < 50000), 500, 0)
 *
 * Everything evaluates in Decimal — no binary floating point anywhere.
 * Booleans are represented as 1 and 0 so they compose with arithmetic.
 */

export class FormulaError extends Error {
  constructor(message: string, public readonly formula?: string) {
    super(formula ? `${message}  (in: ${formula})` : message);
    this.name = "FormulaError";
  }
}

// --- Tokeniser --------------------------------------------------------------

type TokenType =
  | "NUMBER" | "REF" | "IDENT" | "OP" | "COMPARE"
  | "LPAREN" | "RPAREN" | "COMMA" | "EOF";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const COMPARE_OPS = [">=", "<=", "<>", "!=", "==", ">", "<", "="];

function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }

    // Component reference: [BASIC], [CTC_ANNUAL]
    if (ch === "[") {
      const close = input.indexOf("]", i);
      if (close === -1) throw new FormulaError(`Unclosed "[" at position ${i}`, input);
      tokens.push({ type: "REF", value: input.slice(i + 1, close).trim(), pos: i });
      i = close + 1;
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < input.length && (input[j] >= "0" && input[j] <= "9")) j++;
      if (input[j] === ".") {
        j++;
        while (j < input.length && (input[j] >= "0" && input[j] <= "9")) j++;
      }
      tokens.push({ type: "NUMBER", value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // A leading "." on a number, e.g. .5
    if (ch === "." && input[i + 1] >= "0" && input[i + 1] <= "9") {
      let j = i + 1;
      while (j < input.length && (input[j] >= "0" && input[j] <= "9")) j++;
      tokens.push({ type: "NUMBER", value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    const twoChar = input.slice(i, i + 2);
    if (COMPARE_OPS.includes(twoChar)) {
      tokens.push({ type: "COMPARE", value: twoChar, pos: i });
      i += 2;
      continue;
    }
    if (COMPARE_OPS.includes(ch)) {
      tokens.push({ type: "COMPARE", value: ch, pos: i });
      i++;
      continue;
    }

    if ("+-*/%^".includes(ch)) {
      tokens.push({ type: "OP", value: ch, pos: i });
      i++;
      continue;
    }

    if (ch === "(") { tokens.push({ type: "LPAREN", value: ch, pos: i }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "RPAREN", value: ch, pos: i }); i++; continue; }
    if (ch === "," || ch === ";") { tokens.push({ type: "COMMA", value: ",", pos: i }); i++; continue; }

    // Bare identifier: a function name, or a component code written without
    // brackets (tolerated, because real-world formulas are written both ways).
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j])) j++;
      tokens.push({ type: "IDENT", value: input.slice(i, j).toUpperCase(), pos: i });
      i = j;
      continue;
    }

    throw new FormulaError(`Unexpected character "${ch}" at position ${i}`, input);
  }

  tokens.push({ type: "EOF", value: "", pos: input.length });
  return tokens;
}

// --- Evaluation context -----------------------------------------------------

export interface FormulaContext {
  /** Component code -> value. Codes are matched case-insensitively. */
  values: Record<string, Decimal | number | string>;
  /** Resolve a reference this context does not hold. */
  onMissing?: (code: string) => Decimal | undefined;
  /** Codes referenced during evaluation, collected for dependency ordering. */
  collect?: Set<string>;
}

const TRUE = new Decimal(1);
const FALSE = new Decimal(0);

function truthy(d: Decimal): boolean {
  return !d.isZero();
}

// --- Functions --------------------------------------------------------------

type FnImpl = (args: Decimal[], raw: () => Decimal[]) => Decimal;

const FUNCTIONS: Record<string, { arity: [number, number]; lazy?: boolean; fn: FnImpl }> = {
  // IF is lazy: only the taken branch is evaluated, so IF(x>0, 100/x, 0) is safe.
  IF: {
    arity: [3, 3],
    lazy: true,
    fn: () => FALSE, // replaced by the lazy path in the parser
  },
  MIN: { arity: [1, 32], fn: (a) => a.reduce((m, v) => (v.lessThan(m) ? v : m)) },
  MAX: { arity: [1, 32], fn: (a) => a.reduce((m, v) => (v.greaterThan(m) ? v : m)) },
  ABS: { arity: [1, 1], fn: (a) => a[0].abs() },
  ROUND: {
    arity: [1, 2],
    fn: (a) => a[0].toDecimalPlaces(a[1] ? a[1].toNumber() : 0, Decimal.ROUND_HALF_UP),
  },
  ROUNDUP: {
    arity: [1, 2],
    fn: (a) => a[0].toDecimalPlaces(a[1] ? a[1].toNumber() : 0, Decimal.ROUND_CEIL),
  },
  ROUNDDOWN: {
    arity: [1, 2],
    fn: (a) => a[0].toDecimalPlaces(a[1] ? a[1].toNumber() : 0, Decimal.ROUND_FLOOR),
  },
  FLOOR: { arity: [1, 1], fn: (a) => a[0].floor() },
  CEILING: { arity: [1, 1], fn: (a) => a[0].ceil() },
  AND: { arity: [1, 32], fn: (a) => (a.every(truthy) ? TRUE : FALSE) },
  OR: { arity: [1, 32], fn: (a) => (a.some(truthy) ? TRUE : FALSE) },
  NOT: { arity: [1, 1], fn: (a) => (truthy(a[0]) ? FALSE : TRUE) },
  SUM: { arity: [1, 64], fn: (a) => a.reduce((s, v) => s.plus(v), new Decimal(0)) },
  /** Percentage helper: PCT(base, 12) === base * 12 / 100 */
  PCT: { arity: [2, 2], fn: (a) => a[0].times(a[1]).dividedBy(100) },
};

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);

// --- Parser (recursive descent) ---------------------------------------------

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly ctx: FormulaContext,
    private readonly source: string,
  ) {}

  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }

  private expect(type: TokenType, what: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new FormulaError(`Expected ${what} at position ${t.pos}, found "${t.value || "end of formula"}"`, this.source);
    }
    return this.next();
  }

  parse(): Decimal {
    const value = this.parseOr();
    if (this.peek().type !== "EOF") {
      const t = this.peek();
      throw new FormulaError(`Unexpected "${t.value}" at position ${t.pos}`, this.source);
    }
    return value;
  }

  private parseOr(): Decimal {
    let left = this.parseAnd();
    while (this.peek().type === "IDENT" && this.peek().value === "OR") {
      this.next();
      const right = this.parseAnd();
      left = truthy(left) || truthy(right) ? TRUE : FALSE;
    }
    return left;
  }

  private parseAnd(): Decimal {
    let left = this.parseComparison();
    while (this.peek().type === "IDENT" && this.peek().value === "AND") {
      this.next();
      const right = this.parseComparison();
      left = truthy(left) && truthy(right) ? TRUE : FALSE;
    }
    return left;
  }

  private parseComparison(): Decimal {
    const left = this.parseAdditive();
    if (this.peek().type !== "COMPARE") return left;
    const op = this.next().value;
    const right = this.parseAdditive();
    switch (op) {
      case ">":  return left.greaterThan(right) ? TRUE : FALSE;
      case "<":  return left.lessThan(right) ? TRUE : FALSE;
      case ">=": return left.greaterThanOrEqualTo(right) ? TRUE : FALSE;
      case "<=": return left.lessThanOrEqualTo(right) ? TRUE : FALSE;
      case "=":
      case "==": return left.equals(right) ? TRUE : FALSE;
      case "<>":
      case "!=": return left.equals(right) ? FALSE : TRUE;
      default:
        throw new FormulaError(`Unknown comparison "${op}"`, this.source);
    }
  }

  private parseAdditive(): Decimal {
    let left = this.parseMultiplicative();
    while (this.peek().type === "OP" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = op === "+" ? left.plus(right) : left.minus(right);
    }
    return left;
  }

  private parseMultiplicative(): Decimal {
    let left = this.parseUnary();
    while (this.peek().type === "OP" && "*/%".includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseUnary();
      if (op === "*") {
        left = left.times(right);
      } else if (op === "/") {
        // Division by zero yields zero rather than throwing. A salary
        // component that cannot be computed should be 0, not a failed run.
        left = right.isZero() ? new Decimal(0) : left.dividedBy(right);
      } else {
        left = right.isZero() ? new Decimal(0) : left.modulo(right);
      }
    }
    return left;
  }

  private parseUnary(): Decimal {
    const t = this.peek();
    if (t.type === "OP" && (t.value === "-" || t.value === "+")) {
      this.next();
      const v = this.parseUnary();
      return t.value === "-" ? v.negated() : v;
    }
    if (t.type === "IDENT" && t.value === "NOT") {
      this.next();
      return truthy(this.parseUnary()) ? FALSE : TRUE;
    }
    return this.parsePower();
  }

  private parsePower(): Decimal {
    const base = this.parsePrimary();
    if (this.peek().type === "OP" && this.peek().value === "^") {
      this.next();
      const exp = this.parseUnary(); // right-associative
      return base.pow(exp);
    }
    return base;
  }

  private parsePrimary(): Decimal {
    const t = this.next();

    if (t.type === "NUMBER") return new Decimal(t.value);

    if (t.type === "REF") return this.resolve(t.value);

    if (t.type === "LPAREN") {
      const v = this.parseOr();
      this.expect("RPAREN", '")"');
      return v;
    }

    if (t.type === "IDENT") {
      // Function call?
      if (this.peek().type === "LPAREN") {
        return this.parseCall(t.value);
      }
      // Bare word used as a component reference.
      return this.resolve(t.value);
    }

    throw new FormulaError(`Unexpected "${t.value || "end of formula"}" at position ${t.pos}`, this.source);
  }

  private parseCall(name: string): Decimal {
    this.expect("LPAREN", '"(" after function name');

    // IF short-circuits: parse the condition, then evaluate only the branch
    // that is taken and skip the other without evaluating it.
    if (name === "IF") {
      const condition = this.parseOr();
      this.expect("COMMA", '"," after IF condition');
      if (truthy(condition)) {
        const thenValue = this.parseOr();
        this.expect("COMMA", '"," after IF true-branch');
        this.skipExpression();
        this.expect("RPAREN", '")" to close IF');
        return thenValue;
      }
      this.skipExpression();
      this.expect("COMMA", '"," after IF true-branch');
      const elseValue = this.parseOr();
      this.expect("RPAREN", '")" to close IF');
      return elseValue;
    }

    const spec = FUNCTIONS[name];
    if (!spec) {
      throw new FormulaError(
        `Unknown function "${name}". Available: ${FORMULA_FUNCTIONS.join(", ")}`,
        this.source,
      );
    }

    const args: Decimal[] = [];
    if (this.peek().type !== "RPAREN") {
      args.push(this.parseOr());
      while (this.peek().type === "COMMA") {
        this.next();
        args.push(this.parseOr());
      }
    }
    this.expect("RPAREN", `")" to close ${name}`);

    const [min, max] = spec.arity;
    if (args.length < min || args.length > max) {
      throw new FormulaError(
        `${name} takes ${min === max ? min : `${min}-${max}`} argument(s), got ${args.length}`,
        this.source,
      );
    }
    return spec.fn(args, () => args);
  }

  /** Consume one argument's tokens without evaluating them. */
  private skipExpression(): void {
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.type === "EOF") throw new FormulaError("Unexpected end of formula", this.source);
      if (t.type === "LPAREN") depth++;
      if (t.type === "RPAREN") {
        if (depth === 0) return;
        depth--;
      }
      if (t.type === "COMMA" && depth === 0) return;
      this.next();
    }
  }

  private resolve(rawCode: string): Decimal {
    const code = rawCode.trim().toUpperCase();
    this.ctx.collect?.add(code);

    const direct = this.ctx.values[code] ?? this.ctx.values[rawCode.trim()];
    if (direct !== undefined) {
      return direct instanceof Decimal ? direct : new Decimal(direct);
    }

    // Case-insensitive sweep, for contexts keyed in mixed case.
    for (const [key, value] of Object.entries(this.ctx.values)) {
      if (key.toUpperCase() === code) {
        return value instanceof Decimal ? value : new Decimal(value);
      }
    }

    const fallback = this.ctx.onMissing?.(code);
    if (fallback !== undefined) return fallback;

    // An unresolved reference is zero, not an error. A half-configured
    // structure should still produce a payslip with a visible gap rather
    // than aborting the whole run.
    return new Decimal(0);
  }
}

// --- Public API -------------------------------------------------------------

/** Evaluate a formula against a set of component values. */
export function evaluateFormula(formula: string, ctx: FormulaContext): Decimal {
  if (!formula || !formula.trim()) return new Decimal(0);
  const tokens = tokenise(formula);
  return new Parser(tokens, ctx, formula).parse();
}

/** Component codes a formula depends on. Used to order evaluation. */
export function extractReferences(formula: string): string[] {
  if (!formula || !formula.trim()) return [];
  const out = new Set<string>();
  for (const token of tokenise(formula)) {
    if (token.type === "REF") {
      out.add(token.value.trim().toUpperCase());
    } else if (token.type === "IDENT" && !FUNCTIONS[token.value] &&
               !["AND", "OR", "NOT"].includes(token.value)) {
      out.add(token.value);
    }
  }
  return [...out];
}

/** Parse-check a formula without evaluating it against real data. */
export function validateFormula(formula: string): { valid: boolean; error?: string; references: string[] } {
  try {
    const references = extractReferences(formula);
    const probe: Record<string, Decimal> = {};
    for (const ref of references) probe[ref] = new Decimal(1);
    evaluateFormula(formula, { values: probe });
    return { valid: true, references };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
      references: [],
    };
  }
}

/**
 * Order component codes so every formula is evaluated after its dependencies.
 * Returns the order plus any codes caught in a dependency cycle — those are
 * reported rather than silently dropped, because a cycle in a salary
 * structure is a configuration bug the admin needs to see.
 */
export function topologicalOrder(
  items: Array<{ code: string; formula?: string | null }>,
): { order: string[]; cycles: string[] } {
  const deps = new Map<string, string[]>();
  const known = new Set(items.map((i) => i.code.toUpperCase()));

  for (const item of items) {
    const code = item.code.toUpperCase();
    const refs = item.formula ? extractReferences(item.formula) : [];
    deps.set(code, refs.filter((r) => known.has(r) && r !== code));
  }

  const order: string[] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 visiting, 2 done
  const cycles = new Set<string>();

  const visit = (code: string): void => {
    const s = state.get(code) ?? 0;
    if (s === 2) return;
    if (s === 1) { cycles.add(code); return; }
    state.set(code, 1);
    for (const dep of deps.get(code) ?? []) visit(dep);
    state.set(code, 2);
    order.push(code);
  };

  for (const code of known) visit(code);
  return { order, cycles: [...cycles] };
}
