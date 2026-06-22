import * as vscode from "vscode";
import type { AstViewNode } from "../shared/analysis/analysis-types.js";
import { ScopeViewProvider } from "./scope-view.js";
import {
  highlightDecorationType,
  SyntaxTreeProvider,
  toVscodeRange,
} from "./syntax-tree.js";

export class AstSyncController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private selectionSyncTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private suppressEditorSelectionEvent = false;
  private suppressTreeSelectionEvent = false;

  constructor(
    private readonly treeProvider: SyntaxTreeProvider,
    private readonly treeView: vscode.TreeView<AstViewNode>,
    private readonly scopeViewProvider: ScopeViewProvider
  ) {
    this.disposables.push(
      this.treeView.onDidChangeSelection((event) => {
        if (this.suppressTreeSelectionEvent) {
          return;
        }

        const node = event.selection[0];
        if (!node) {
          return;
        }

        const range = toVscodeRange(node.range);
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.languageId === "stella") {
          void this.scopeViewProvider.updateForNode(editor.document, node, range?.start);
        }
        void this.revealNodeInEditor(node);
      }),

      this.treeView.onDidChangeVisibility(() => {
        if (this.treeView.visible) {
          void this.syncToActiveEditor();
        }
      }),

      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.clearHighlight();
        this.treeProvider.refresh();

        if (editor?.document.languageId === "stella") {
          void this.syncEditorWithDelay(editor, 50);
        } else {
          this.scopeViewProvider.clear();
        }
      }),

      vscode.window.onDidChangeTextEditorSelection((event) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || event.textEditor !== activeEditor) {
          return;
        }

        if (this.suppressEditorSelectionEvent) {
          return;
        }

        if (event.textEditor.document.languageId !== "stella") {
          this.clearHighlight();
          this.scopeViewProvider.clear();
          return;
        }

        void this.syncEditorWithDelay(event.textEditor, 120);
      }),

      vscode.workspace.onDidChangeTextDocument((event) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          return;
        }

        if (event.document !== activeEditor.document) {
          return;
        }

        if (activeEditor.document.languageId !== "stella") {
          return;
        }

        this.scheduleRefreshAndSync(activeEditor);
      }),

      vscode.workspace.onDidSaveTextDocument((document) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document !== document) {
          return;
        }

        if (document.languageId !== "stella") {
          return;
        }

        this.treeProvider.refresh();
        void this.syncToActiveEditor();
      })
    );
  }

  async syncToActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "stella") {
      this.clearHighlight();
      this.scopeViewProvider.clear();
      return;
    }

    const node = await this.treeProvider.findNodeAtPosition(
      editor.document,
      editor.selection.active
    );

    if (!node) {
      this.clearHighlight();
      this.scopeViewProvider.clear();
      return;
    }

    this.applyHighlight(node);
    await this.scopeViewProvider.updateForNode(
      editor.document,
      node,
      editor.selection.active
    );

    try {
      this.suppressTreeSelectionEvent = true;
      await this.treeView.reveal(node, {
        select: true,
        focus: false,
        expand: true,
      });
    } catch {
      // ignore reveal errors when tree view is not ready yet
    } finally {
      this.suppressTreeSelectionEvent = false;
    }
  }

  refreshAndSync(): void {
    this.treeProvider.refresh();
    void this.syncToActiveEditor();
  }

  dispose(): void {
    if (this.selectionSyncTimer) {
      clearTimeout(this.selectionSyncTimer);
    }

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private scheduleRefreshAndSync(editor: vscode.TextEditor): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.treeProvider.refresh();
      void this.syncToActiveEditor();
    }, 250);
  }

  private async syncEditorWithDelay(
    editor: vscode.TextEditor,
    delayMs: number
  ): Promise<void> {
    if (this.selectionSyncTimer) {
      clearTimeout(this.selectionSyncTimer);
    }

    this.selectionSyncTimer = setTimeout(() => {
      void this.syncToActiveEditor();
    }, delayMs);
  }

  private async revealNodeInEditor(node: AstViewNode): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "stella") {
      return;
    }

    const range = toVscodeRange(node.range);
    if (!range) {
      return;
    }

    try {
      this.suppressEditorSelectionEvent = true;

      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.setDecorations(highlightDecorationType, [range]);
    } finally {
      this.suppressEditorSelectionEvent = false;
    }
  }

  private applyHighlight(node: AstViewNode): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const range = toVscodeRange(node.range);
    if (!range) {
      editor.setDecorations(highlightDecorationType, []);
      return;
    }

    editor.setDecorations(highlightDecorationType, [range]);
  }

  private clearHighlight(): void {
    vscode.window.activeTextEditor?.setDecorations(
      highlightDecorationType,
      []
    );
  }
}