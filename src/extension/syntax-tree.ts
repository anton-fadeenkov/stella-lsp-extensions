import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node.js";
import type {
  AnalysisRange,
  AstViewModel,
  AstViewNode,
} from "../shared/analysis/analysis-types.js";
import type { AstRequestResult } from "../shared/lsp/ast-protocol.js";
import { STELLA_AST_REQUEST } from "../shared/lsp/ast-protocol.js";

export function toVscodeRange(range?: AnalysisRange): vscode.Range | undefined {
  if (!range) {
    return undefined;
  }

  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}

function formatRange(range?: AnalysisRange): string | undefined {
  if (!range) {
    return undefined;
  }

  return `${range.start.line + 1}:${range.start.character + 1} - ${
    range.end.line + 1
  }:${range.end.character + 1}`;
}

function comparePositions(
  left: vscode.Position,
  right: vscode.Position
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

function containsPosition(
  range: AnalysisRange | undefined,
  position: vscode.Position
): boolean {
  if (!range) {
    return false;
  }

  const start = new vscode.Position(range.start.line, range.start.character);
  const end = new vscode.Position(range.end.line, range.end.character);

  return (
    comparePositions(position, start) >= 0 &&
    comparePositions(position, end) <= 0
  );
}

function findDeepestContainingNode(
  node: AstViewNode,
  position: vscode.Position
): AstViewNode | undefined {
  if (!containsPosition(node.range, position)) {
    return undefined;
  }

  for (const child of node.children) {
    const match = findDeepestContainingNode(child, position);
    if (match) {
      return match;
    }
  }

  return node;
}

export class SyntaxTreeProvider
  implements vscode.TreeDataProvider<AstViewNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    AstViewNode | undefined | void
  >();

  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentTree?: AstViewModel;
  private currentUri?: string;
  private parentById = new Map<string, AstViewNode | undefined>();
  private pendingLoad?: Promise<AstViewModel | undefined>;
  private pendingLoadUri?: string;

  constructor(private readonly client: LanguageClient) {}

  refresh(): void {
    this.currentTree = undefined;
    this.currentUri = undefined;
    this.parentById.clear();
    this.pendingLoad = undefined;
    this.pendingLoadUri = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AstViewNode): vscode.TreeItem {
    const hasChildren = element.children.length > 0;

    const item = new vscode.TreeItem(
      element.label,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    item.description = element.edgeLabel;
    item.iconPath = new vscode.ThemeIcon(
      hasChildren ? "symbol-struct" : "symbol-field"
    );

    const tooltipLines: string[] = [
      `type: ${element.type}`,
      `id: ${element.id}`,
    ];

    const rangeText = formatRange(element.range);
    if (rangeText) {
      tooltipLines.push(`range: ${rangeText}`);
    }

    if (element.truncated) {
      tooltipLines.push("children hidden because of depth limit");
    }

    item.tooltip = tooltipLines.join("\n");
    item.contextValue = "astNode";

    return item;
  }

  async getChildren(element?: AstViewNode): Promise<AstViewNode[]> {
    if (element) {
      return element.children;
    }

    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "stella") {
      return [];
    }

    const tree = await this.loadTreeForDocument(document);
    if (!tree) {
      return [];
    }

    return [tree.root];
  }

  getParent(element: AstViewNode): AstViewNode | undefined {
    return this.parentById.get(element.id);
  }

  getPathToRoot(element: AstViewNode): AstViewNode[] {
    const path: AstViewNode[] = [];
    let current: AstViewNode | undefined = element;

    while (current) {
      path.unshift(current);
      current = this.parentById.get(current.id);
    }

    return path;
  }

  async getTreeForActiveDocument(): Promise<AstViewModel | undefined> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "stella") {
      return undefined;
    }

    return this.loadTreeForDocument(document);
  }

  async findNodeAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<AstViewNode | undefined> {
    const tree = await this.loadTreeForDocument(document);
    if (!tree) {
      return undefined;
    }

    return findDeepestContainingNode(tree.root, position);
  }

  private async loadTreeForDocument(
    document: vscode.TextDocument
  ): Promise<AstViewModel | undefined> {
    const uri = document.uri.toString();

    if (this.currentTree && this.currentUri === uri) {
      return this.currentTree;
    }

    if (this.pendingLoad && this.pendingLoadUri === uri) {
      return this.pendingLoad;
    }

    this.pendingLoadUri = uri;
    this.pendingLoad = this.client
      .sendRequest<AstRequestResult>(STELLA_AST_REQUEST, {
        uri,
      })
      .then((tree) => {
        if (!tree) {
          this.currentTree = undefined;
          this.currentUri = undefined;
          this.parentById.clear();
          return undefined;
        }

        this.currentTree = tree;
        this.currentUri = uri;
        this.rebuildParentIndex(tree.root);

        return tree;
      })
      .finally(() => {
        this.pendingLoad = undefined;
        this.pendingLoadUri = undefined;
      });

    return this.pendingLoad;
  }

  private rebuildParentIndex(root: AstViewNode): void {
    this.parentById.clear();

    const visit = (
      node: AstViewNode,
      parent: AstViewNode | undefined
    ): void => {
      this.parentById.set(node.id, parent);

      for (const child of node.children) {
        visit(child, node);
      }
    };

    visit(root, undefined);
  }
}

export const highlightDecorationType =
  vscode.window.createTextEditorDecorationType({
    border: "1px solid rgb(255, 128, 0)",
    borderRadius: "4px",
    backgroundColor: "rgba(255, 128, 0, 0.2)",
  });