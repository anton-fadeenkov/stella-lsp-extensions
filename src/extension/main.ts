import type {
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node.js";
import * as vscode from "vscode";
import * as path from "node:path";
import { LanguageClient, TransportKind } from "vscode-languageclient/node.js";
import { AstSyncController } from "./ast-sync-controller.js";
import { ScopeViewProvider } from "./scope-view.js";
import {
  highlightDecorationType,
  SyntaxTreeProvider,
} from "./syntax-tree.js";
import { registerShowAstJsonCommand } from "./show-ast-command.js";
import { showTypeDerivationPanel } from "./type-derivation-panel.js";
import { showTypeErrorTracePanel } from "./type-error-trace-panel.js";
import { showTypeDependencyGraphPanel } from "./type-dependency-graph-panel.js";

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext): void {
  client = startLanguageClient(context);

  const syntaxTreeProvider = new SyntaxTreeProvider(client);
  const scopeViewProvider = new ScopeViewProvider(client);

  const syntaxTreeView = vscode.window.createTreeView("syntaxTree", {
    treeDataProvider: syntaxTreeProvider,
    showCollapseAll: true,
  });

  const scopeTreeView = vscode.window.createTreeView("scopeContext", {
    treeDataProvider: scopeViewProvider,
    showCollapseAll: true,
  });

  const astSyncController = new AstSyncController(
    syntaxTreeProvider,
    syntaxTreeView,
    scopeViewProvider
  );

  context.subscriptions.push(
    syntaxTreeView,
    scopeTreeView,
    scopeViewProvider,
    astSyncController,

    vscode.commands.registerCommand(
      "stella.highlightRegion",
      (ranges: vscode.Range | vscode.Range[]) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }

        const normalizedRanges = Array.isArray(ranges) ? ranges : [ranges];

        editor.revealRange(
          normalizedRanges[0],
          vscode.TextEditorRevealType.InCenter
        );
        editor.setDecorations(highlightDecorationType, normalizedRanges);
      }
    ),

    vscode.commands.registerCommand("stella.refreshSyntaxTree", () => {
      astSyncController.refreshAndSync();
    }),

    vscode.commands.registerCommand("stella.showTypeDerivation", () =>
      showTypeDerivationPanel(client, context)
    ),

    vscode.commands.registerCommand("stella.showTypeErrorTrace", () =>
      showTypeErrorTracePanel(client, context)
    ),

    vscode.commands.registerCommand("stella.showTypeDependencyGraph", () =>
      showTypeDependencyGraphPanel(client, context)
    ),

    registerShowAstJsonCommand(client)
  );

  void astSyncController.syncToActiveEditor();
}

export function deactivate(): Thenable<void> | undefined {
  if (client) {
    return client.stop();
  }
  return undefined;
}

function startLanguageClient(context: vscode.ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(
    path.join("out", "language", "main.cjs")
  );

  const debugOptions = {
    execArgv: [
      "--nolazy",
      `--inspect${process.env.DEBUG_BREAK ? "-brk" : ""}=${
        process.env.DEBUG_SOCKET || "6009"
      }`,
    ],
  };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "*", language: "stella" }],
  };

  const client = new LanguageClient(
    "stella",
    "Stella",
    serverOptions,
    clientOptions
  );

  client.start();
  return client;
}
