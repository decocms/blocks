/**
 * A thin, read-only view over the TypeScript compiler API: the handful of
 * type, symbol and node queries the schema generator makes.
 *
 * `deco schema` reads types with the app's own `typescript`, a peer
 * dependency loaded with `import()` only when the command runs (spec:
 * internals › How the CLI ships), so the schema is built with the compiler
 * version the app type-checks with and nothing compiler-sized is installed
 * on the package's behalf.
 *
 * The method names follow the subset of ts-morph's API the v7 generator was
 * written against (the engine in ./typeToSchema.ts is a port of it), with the
 * same semantics, so the port reads the same as the code it came from. Every
 * wrapper is cached per compiler object, so `===` on two views means the same
 * type, symbol or node.
 */
import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import { CliError } from "../root.ts";

type TypeScript = typeof TS;

/** Load the app's `typescript`. Throws a `CliError` with the fix when it isn't installed. */
export async function loadTypeScript(): Promise<TypeScript> {
  try {
    const mod = (await import("typescript")) as TypeScript & { default?: TypeScript };
    return mod.default ?? mod;
  } catch {
    throw new CliError(
      "deco schema reads your types with TypeScript, which isn't installed: add typescript to your devDependencies",
    );
  }
}

class Context {
  readonly types = new WeakMap<TS.Type, TsType>();
  readonly symbols = new WeakMap<TS.Symbol, TsSymbol>();
  readonly nodes = new WeakMap<TS.Node, TsNode>();
  readonly signatures = new WeakMap<TS.Signature, TsSignature>();

  constructor(
    readonly ts: TypeScript,
    readonly checker: TS.TypeChecker,
  ) {}

  type(t: TS.Type): TsType {
    return cached(this.types, t, () => new TsType(this, t));
  }

  symbol(s: TS.Symbol): TsSymbol {
    return cached(this.symbols, s, () => new TsSymbol(this, s));
  }

  node(n: TS.Node): TsNode {
    return cached(this.nodes, n, () =>
      this.ts.isSourceFile(n) ? new TsSourceFile(this, n) : new TsNode(this, n),
    );
  }

  signature(s: TS.Signature): TsSignature {
    return cached(this.signatures, s, () => new TsSignature(this, s));
  }
}

function cached<K extends object, V>(map: WeakMap<K, V>, key: K, create: () => V): V {
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const value = create();
  map.set(key, value);
  return value;
}

export class TsType {
  constructor(
    private readonly ctx: Context,
    readonly compilerType: TS.Type,
  ) {}

  private hasFlag(flag: TS.TypeFlags): boolean {
    return (this.compilerType.flags & flag) === flag;
  }

  private objectFlags(): number {
    return this.isObject() ? ((this.compilerType as TS.ObjectType).objectFlags ?? 0) : 0;
  }

  /** The type as the checker prints it (ts-morph's default format flags). */
  getText(): string {
    const F = this.ctx.ts.TypeFormatFlags;
    return this.ctx.checker.typeToString(
      this.compilerType,
      undefined,
      F.UseTypeOfFunction |
        F.NoTruncation |
        F.UseFullyQualifiedType |
        F.WriteTypeArgumentsOfSignature,
    );
  }

  getSymbol(): TsSymbol | undefined {
    const s = this.compilerType.getSymbol();
    return s ? this.ctx.symbol(s) : undefined;
  }

  getAliasSymbol(): TsSymbol | undefined {
    const s = this.compilerType.aliasSymbol;
    return s ? this.ctx.symbol(s) : undefined;
  }

  getAliasTypeArguments(): TsType[] {
    return (this.compilerType.aliasTypeArguments ?? []).map((t) => this.ctx.type(t));
  }

  getTypeArguments(): TsType[] {
    return this.ctx.checker
      .getTypeArguments(this.compilerType as TS.TypeReference)
      .map((t) => this.ctx.type(t));
  }

  getCallSignatures(): TsSignature[] {
    return this.compilerType.getCallSignatures().map((s) => this.ctx.signature(s));
  }

  getProperties(): TsSymbol[] {
    return this.compilerType.getProperties().map((s) => this.ctx.symbol(s));
  }

  getProperty(name: string): TsSymbol | undefined {
    return this.getProperties().find((p) => p.getName() === name);
  }

  getStringIndexType(): TsType | undefined {
    const t = this.compilerType.getStringIndexType();
    return t ? this.ctx.type(t) : undefined;
  }

  getNumberIndexType(): TsType | undefined {
    const t = this.compilerType.getNumberIndexType();
    return t ? this.ctx.type(t) : undefined;
  }

  getNonNullableType(): TsType {
    return this.ctx.type(this.compilerType.getNonNullableType());
  }

  getUnionTypes(): TsType[] {
    return this.isUnion()
      ? (this.compilerType as TS.UnionType).types.map((t) => this.ctx.type(t))
      : [];
  }

  getIntersectionTypes(): TsType[] {
    return this.isIntersection()
      ? (this.compilerType as TS.IntersectionType).types.map((t) => this.ctx.type(t))
      : [];
  }

  getArrayElementType(): TsType | undefined {
    return this.isArray() ? this.getTypeArguments()[0] : undefined;
  }

  getLiteralValue(): unknown {
    return (this.compilerType as TS.LiteralType).value;
  }

  isAssignableTo(target: TsType): boolean {
    return this.ctx.checker.isTypeAssignableTo(this.compilerType, target.compilerType);
  }

  isArray(): boolean {
    const name = this.getSymbol()?.getName();
    return (name === "Array" || name === "ReadonlyArray") && this.getTypeArguments().length === 1;
  }

  isAny(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Any);
  }
  isUnknown(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Unknown);
  }
  isNever(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Never);
  }
  isVoid(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Void);
  }
  isString(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.String);
  }
  isNumber(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Number);
  }
  isBoolean(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Boolean);
  }
  isBooleanLiteral(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.BooleanLiteral);
  }
  isNumberLiteral(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.NumberLiteral);
  }
  isStringLiteral(): boolean {
    return this.compilerType.isStringLiteral();
  }
  isLiteral(): boolean {
    return this.compilerType.isLiteral() || this.isBooleanLiteral();
  }
  isNull(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Null);
  }
  isUndefined(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Undefined);
  }
  isUnion(): boolean {
    return this.compilerType.isUnion();
  }
  isIntersection(): boolean {
    return this.compilerType.isIntersection();
  }
  isObject(): boolean {
    return this.hasFlag(this.ctx.ts.TypeFlags.Object);
  }
  isInterface(): boolean {
    const flag = this.ctx.ts.ObjectFlags.Interface;
    return (this.objectFlags() & flag) === flag;
  }
}

export class TsSymbol {
  constructor(
    private readonly ctx: Context,
    readonly compilerSymbol: TS.Symbol,
  ) {}

  getName(): string {
    return this.compilerSymbol.getName();
  }

  getDeclarations(): TsNode[] {
    return (this.compilerSymbol.declarations ?? []).map((d) => this.ctx.node(d));
  }

  getValueDeclaration(): TsNode | undefined {
    const d = this.compilerSymbol.valueDeclaration;
    return d ? this.ctx.node(d) : undefined;
  }

  getTypeAtLocation(node: TsNode): TsType {
    return this.ctx.type(
      this.ctx.checker.getTypeOfSymbolAtLocation(this.compilerSymbol, node.compilerNode),
    );
  }

  private hasFlag(flag: TS.SymbolFlags): boolean {
    return (this.compilerSymbol.getFlags() & flag) === flag;
  }

  isOptional(): boolean {
    return this.hasFlag(this.ctx.ts.SymbolFlags.Optional);
  }

  isAlias(): boolean {
    return this.hasFlag(this.ctx.ts.SymbolFlags.Alias);
  }

  getAliasedSymbol(): TsSymbol | undefined {
    const s = this.ctx.checker.getAliasedSymbol(this.compilerSymbol);
    return s ? this.ctx.symbol(s) : undefined;
  }
}

export class TsSignature {
  constructor(
    private readonly ctx: Context,
    readonly compilerSignature: TS.Signature,
  ) {}

  getParameters(): TsSymbol[] {
    return this.compilerSignature.parameters.map((p) => this.ctx.symbol(p));
  }

  getReturnType(): TsType {
    return this.ctx.type(this.compilerSignature.getReturnType());
  }

  getDeclaration(): TsNode | undefined {
    const d = this.compilerSignature.getDeclaration();
    return d ? this.ctx.node(d) : undefined;
  }
}

/** One JSDoc comment: its description and its tags. */
export interface JsDocView {
  getDescription(): string;
  getTags(): { getTagName(): string; getCommentText(): string | undefined }[];
}

export class TsNode {
  constructor(
    protected readonly ctx: Context,
    readonly compilerNode: TS.Node,
  ) {}

  getSourceFile(): TsSourceFile {
    return this.ctx.node(this.compilerNode.getSourceFile()) as TsSourceFile;
  }

  getParent(): TsNode | undefined {
    const p = this.compilerNode.parent;
    return p ? this.ctx.node(p) : undefined;
  }

  getText(): string {
    return this.compilerNode.getText(this.compilerNode.getSourceFile());
  }

  /** The type annotation as written, on a property or variable declaration. */
  getTypeNode(): TsNode | undefined {
    const t = (this.compilerNode as { type?: TS.Node }).type;
    return t && typeof t === "object" && "kind" in t ? this.ctx.node(t) : undefined;
  }

  /**
   * The declarations of the type aliases a type annotation names, as written:
   * `Kind` and `Kind | null` both give `Kind`'s. The checker drops the alias
   * from `Kind | undefined`, so this is how a field finds its alias.
   */
  getAliasDeclarationTexts(): string[] {
    const ts = this.ctx.ts;
    const node = this.compilerNode as TS.TypeNode;
    const members = ts.isUnionTypeNode(node) ? node.types : [node];
    const texts: string[] = [];
    for (const member of members) {
      const decl = this.ctx.checker.getTypeFromTypeNode(member).aliasSymbol?.declarations?.[0];
      if (decl) texts.push(decl.getText(decl.getSourceFile()));
    }
    return texts;
  }

  /** Whether `other` is this node or inside it. */
  contains(other: TsNode): boolean {
    const a = this.compilerNode;
    const b = other.compilerNode;
    return a.getSourceFile() === b.getSourceFile() && a.pos <= b.pos && b.end <= a.end;
  }

  getJsDocs(): JsDocView[] {
    const docs = (this.compilerNode as { jsDoc?: TS.JSDoc[] }).jsDoc ?? [];
    return docs.map((doc) => jsDocView(this.ctx.ts, doc));
  }
}

export class TsSourceFile extends TsNode {
  getFilePath(): string {
    return (this.compilerNode as TS.SourceFile).fileName;
  }

  getDefaultExportSymbol(): TsSymbol | undefined {
    const symbol = this.ctx.checker.getSymbolAtLocation(this.compilerNode);
    const exported = symbol?.exports?.get(this.ctx.ts.escapeLeadingUnderscores("default"));
    return exported ? this.ctx.symbol(exported) : undefined;
  }

  /** The declared type of a top-level interface. */
  getInterfaceType(name: string): TsType {
    const decl = (this.compilerNode as TS.SourceFile).statements.find(
      (s): s is TS.InterfaceDeclaration =>
        this.ctx.ts.isInterfaceDeclaration(s) && s.name.text === name,
    );
    if (!decl) throw new Error(`no interface ${name} in ${this.getFilePath()}`);
    return this.ctx.type(this.ctx.checker.getTypeAtLocation(decl));
  }
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
}

function previousMatchingPos(text: string, start: number, match: (code: number) => boolean) {
  let pos = start;
  while (pos > 0 && !match(text.charCodeAt(pos - 1))) pos--;
  return pos;
}

function textWithoutStars(input: string): string {
  const inner = input.replace(/^\/\*\*[^\S\n]*\n?/, "").replace(/(\r?\n)?[^\S\n]*\*\/$/, "");
  return inner
    .split(/\n/)
    .map((line) => {
      let star = -1;
      for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        if (code === 42) {
          star = i;
          break;
        }
        if (!isWhitespace(code)) break;
      }
      if (star === -1) return line;
      return line.substring(line[star + 1] === " " ? star + 2 : star + 1);
    })
    .join("\n");
}

/**
 * A JSDoc comment's description: the raw text before the first tag, without
 * the comment's stars (ts-morph's `JSDoc.getDescription`, so a description
 * keeps the line breaks and inline markup it was written with).
 */
function jsDocView(ts: TypeScript, doc: TS.JSDoc): JsDocView {
  const sourceFile = doc.getSourceFile();
  const commentText = (comment: TS.JSDoc["comment"]) =>
    typeof comment === "string" ? comment : ts.getTextOfJSDocComment(comment);
  return {
    getDescription() {
      const text = sourceFile.getFullText();
      const firstTag = doc.tags?.[0];
      const endSearchStart = firstTag ? firstTag.getStart(sourceFile) : doc.end - 2;
      let start = doc.getStart(sourceFile) + 3;
      if (text.charCodeAt(start) === 32) start++;
      const endOrNewLine = previousMatchingPos(
        text,
        endSearchStart,
        (c) => c === 10 || (!isWhitespace(c) && c !== 42),
      );
      const end = previousMatchingPos(text, endOrNewLine, (c) => c !== 10 && c !== 13);
      return textWithoutStars(text.substring(start, Math.max(start, end)));
    },
    getTags() {
      return (doc.tags ?? []).map((tag) => ({
        getTagName: () => tag.tagName.getText(sourceFile),
        getCommentText: () => commentText(tag.comment),
      }));
    },
  };
}

export interface TsProject {
  ts: TypeScript;
  sourceFile(file: string): TsSourceFile;
  /** Every file the program read from disk (lib files and dependencies included). */
  fileNames(): string[];
}

/** Compiler options when the app has no tsconfig.json. */
function defaultOptions(ts: TypeScript): TS.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    resolveJsonModule: true,
  };
}

function readCompilerOptions(ts: TypeScript, root: string): TS.CompilerOptions {
  const tsconfig = path.join(root, "tsconfig.json");
  if (!fs.existsSync(tsconfig)) return defaultOptions(ts);
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) {
    throw new CliError(
      `${tsconfig}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
    );
  }
  // Only the options: the program's files are the block map and what it imports.
  return ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, tsconfig).options;
}

/**
 * A program over the block map (and everything it imports) plus in-memory
 * files, with the app's tsconfig options when it has one.
 */
export async function createTsProject(
  root: string,
  rootFiles: string[],
  virtualFiles: Record<string, string> = {},
): Promise<TsProject> {
  const ts = await loadTypeScript();
  const options = readCompilerOptions(ts, root);
  const host = ts.createCompilerHost(options, true);
  const virtual = new Map(Object.entries(virtualFiles).map(([f, text]) => [path.resolve(f), text]));
  const { getSourceFile, fileExists, readFile } = host;
  host.fileExists = (file) => virtual.has(path.resolve(file)) || fileExists.call(host, file);
  host.readFile = (file) => virtual.get(path.resolve(file)) ?? readFile.call(host, file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(path.resolve(file));
    return text !== undefined
      ? ts.createSourceFile(file, text, languageVersion, true)
      : getSourceFile.call(host, file, languageVersion, onError, shouldCreate);
  };
  const program = ts.createProgram({
    rootNames: [...Object.keys(virtualFiles), ...rootFiles],
    options,
    host,
  });
  const ctx = new Context(ts, program.getTypeChecker());
  return {
    ts,
    sourceFile(file) {
      const sf = program.getSourceFile(file);
      if (!sf) throw new CliError(`couldn't read ${file}`);
      return ctx.node(sf) as TsSourceFile;
    },
    fileNames() {
      return program
        .getSourceFiles()
        .map((sf) => sf.fileName)
        .filter((f) => !virtual.has(path.resolve(f)));
    },
  };
}
