import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node.js";
import type {
  AnalysisRange,
  AstViewNode,
} from "../shared/analysis/analysis-types.js";
import type {
  ScopeBindingView,
  ScopeFrameView,
  ScopeSnapshotView,
} from "../shared/analysis/scope-types.js";
import type { ScopeRequestResult } from "../shared/lsp/scope-protocol.js";
import { STELLA_SCOPE_REQUEST } from "../shared/lsp/scope-protocol.js";
import { toVscodeRange } from "./syntax-tree.js";

type ScopeTreeElementKind = "header" | "frame" | "binding" | "empty" | "error";

class ScopeTreeElement {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly kind: ScopeTreeElementKind,
    readonly description?: string,
    readonly tooltip?: string,
    readonly range?: vscode.Range,
    readonly children: ScopeTreeElement[] = []
  ) {}
}

function toAnalysisPosition(position: vscode.Position) {
  return {
    line: position.line,
    character: position.character,
  };
}

function formatRange(range?: AnalysisRange): string | undefined {
  if (!range) {
    return undefined;
  }

  return `${range.start.line + 1}:${range.start.character + 1} - ${
    range.end.line + 1
  }:${range.end.character + 1}`;
}

export class ScopeViewProvider
  implements vscode.TreeDataProvider<ScopeTreeElement>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ScopeTreeElement | undefined | void
  >();

  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentElements: ScopeTreeElement[] = [];
  private requestVersion = 0;

  constructor(private readonly client: LanguageClient) {}

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  clear(): void {
    this.currentElements = [];
    this.requestVersion += 1;
    this._onDidChangeTreeData.fire();
  }

  async updateForNode(
    document: vscode.TextDocument,
    node: AstViewNode,
    position?: vscode.Position
  ): Promise<void> {
    const nodeRange = toVscodeRange(node.range);
    await this.updateForPosition(document, position ?? nodeRange?.start);
  }

  async updateForPosition(
    document: vscode.TextDocument,
    position?: vscode.Position
  ): Promise<void> {
    if (document.languageId !== "stella" || !position) {
      this.clear();
      return;
    }

    const version = ++this.requestVersion;

    try {
      const snapshot = await this.client.sendRequest<ScopeRequestResult>(
        STELLA_SCOPE_REQUEST,
        {
          uri: document.uri.toString(),
          position: toAnalysisPosition(position),
        }
      );

      if (version !== this.requestVersion) {
        return;
      }

      if (!snapshot) {
          this.currentElements = [
          new ScopeTreeElement(
            "empty:no-snapshot",
            "No scope information available",
            "empty",
            undefined,
            "The Stella language server did not return a scope snapshot for the current cursor position."
          ),
        ];
        this._onDidChangeTreeData.fire();
        return;
      }

      this.currentElements = this.buildTreeElements(snapshot);
      this._onDidChangeTreeData.fire();
    } catch (error) {
      if (version !== this.requestVersion) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.currentElements = [
        new ScopeTreeElement(
          "error:scope-request",
          "Failed to load scope",
          "error",
          message,
          message
        ),
      ];
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: ScopeTreeElement): vscode.TreeItem {
    const hasChildren = element.children.length > 0;

    const item = new vscode.TreeItem(
      element.label,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );

    item.description = element.description;
    item.tooltip = element.tooltip;

    if (element.kind === "header") {
      item.iconPath = new vscode.ThemeIcon("symbol-misc");
    } else if (element.kind === "frame") {
      item.iconPath = new vscode.ThemeIcon("symbol-namespace");
    } else if (element.kind === "binding") {
      item.iconPath = new vscode.ThemeIcon("symbol-variable");
    } else if (element.kind === "error") {
      item.iconPath = new vscode.ThemeIcon("error");
    } else {
      item.iconPath = new vscode.ThemeIcon("info");
    }

    if (element.range) {
      item.command = {
        command: "stella.highlightRegion",
        title: "Highlight Region",
        arguments: [element.range],
      };
    }

    return item;
  }

  getChildren(element?: ScopeTreeElement): ScopeTreeElement[] {
    if (element) {
      return element.children;
    }

    if (this.currentElements.length > 0) {
      return this.currentElements;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "stella") {
      return [
        new ScopeTreeElement(
          "empty:no-document",
          "Open a Stella file to inspect scope",
          "empty"
        ),
      ];
    }

    return [
      new ScopeTreeElement(
        "empty:no-node",
        "Move the cursor inside the program to inspect scope",
        "empty"
      ),
    ];
  }

  private buildTreeElements(snapshot: ScopeSnapshotView): ScopeTreeElement[] {
    const elements: ScopeTreeElement[] = [];
    const activeRange = toVscodeRange(snapshot.activeRange);
    const rangeText = formatRange(snapshot.activeRange);

    const headerDescriptionParts = [snapshot.activeNodeType];
    if (rangeText) {
      headerDescriptionParts.push(rangeText);
    }

    elements.push(
      new ScopeTreeElement(
        `active:${snapshot.activeNodeId}`,
        `Current node: ${snapshot.activeNodeLabel}`,
        "header",
        headerDescriptionParts.filter(Boolean).join(" • "),
        [
          "Active AST node",
          snapshot.activeNodeLabel,
          snapshot.activeNodeType
            ? `type: ${snapshot.activeNodeType}`
            : undefined,
          rangeText ? `range: ${rangeText}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        activeRange
      )
    );

    if (snapshot.frames.length === 0) {
      elements.push(
        new ScopeTreeElement(
          "empty:no-bindings",
          "No visible bindings at this position",
          "empty",
          "Γ = ∅",
          "No variables or functions are in scope for the current cursor position."
        )
      );
      return elements;
    }

    for (const frame of snapshot.frames) {
      elements.push(this.buildFrameElement(frame));
    }

    return elements;
  }

  private buildFrameElement(frame: ScopeFrameView): ScopeTreeElement {
    const bindingElements = frame.bindings.map((binding) =>
      this.buildBindingElement(binding)
    );

    return new ScopeTreeElement(
      frame.id,
      frame.label,
      "frame",
      `${frame.bindings.length} bindings`,
      `Context frame\n${frame.label}`,
      undefined,
      bindingElements
    );
  }

  private buildBindingElement(binding: ScopeBindingView): ScopeTreeElement {
    const rangeText = formatRange(binding.range);
    const tooltip = [
      `name: ${binding.name}`,
      `kind: ${binding.kind}`,
      `type: ${binding.typeLabel}`,
      `source: ${binding.sourceLabel}`,
      rangeText ? `range: ${rangeText}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    return new ScopeTreeElement(
      binding.id,
      binding.name,
      "binding",
      `${binding.kind} • ${binding.typeLabel}`,
      tooltip,
      toVscodeRange(binding.range)
    );
  }
}
