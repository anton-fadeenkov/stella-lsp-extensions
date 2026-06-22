import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node.js";
import type { AnalysisRange } from "../shared/analysis/analysis-types.js";
import type { TypeDerivationNode } from "../shared/analysis/type-derivation-types.js";
import type { TypeDerivationRequestResult } from "../shared/lsp/type-derivation-protocol.js";
import { STELLA_TYPE_DERIVATION_REQUEST } from "../shared/lsp/type-derivation-protocol.js";
import {
  highlightDecorationType,
  toVscodeRange,
} from "./syntax-tree.js";

let currentPanel: vscode.WebviewPanel | undefined;
let panelDisposables: vscode.Disposable[] = [];
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let currentClient: LanguageClient | undefined;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function encodeRange(range: AnalysisRange | undefined): string {
  return range ? escapeHtml(JSON.stringify(range)) : "";
}

function renderNode(node: TypeDerivationNode): string {
  const premises =
    node.premises.length > 0
      ? `<div class="premises">${node.premises.map((entry) => renderNode(entry)).join("")}</div>`
      : `<div class="premises premises-empty"></div>`;

  const clickableClass = node.range ? " derivation-node-clickable" : "";
  const rangeAttribute = node.range ? `data-range="${encodeRange(node.range)}"` : "";

  return `
    <div class="derivation-node${clickableClass}" ${rangeAttribute}>
      ${premises}
      <div class="rule-line">
        <div class="rule-bar"></div>
        <div class="rule-name">${escapeHtml(node.ruleName)}</div>
      </div>
      <div class="conclusion">${escapeHtml(node.conclusion)}</div>
    </div>
  `;
}

function getHtml(
  webview: vscode.Webview,
  response: TypeDerivationRequestResult,
  subtitle: string
): string {
  const nonce = String(Date.now());
  const root = response?.root;

  if (!root) {
    return getPlaceholderHtml(webview, "No derivation available", subtitle);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Type derivation</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: "Times New Roman", Georgia, serif;
    }

    .toolbar {
      margin-bottom: 16px;
      padding: 12px 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-sideBar-background) 10%);
      font-family: var(--vscode-font-family);
    }

    .toolbar h1 {
      margin: 0 0 4px;
      font-size: 12px;
      font-weight: 600;
    }

    .toolbar p {
      margin: 0;
      font-size: 12px;
      opacity: 0.8;
    }

    .canvas {
      overflow: auto;
      padding: 20px 16px 28px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-sideBar-background) 5%);
    }

    .derivation-root {
      display: inline-flex;
      min-width: 100%;
      justify-content: center;
      align-items: flex-start;
    }

    .derivation-node {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      margin: 0 8px;
      border-radius: 10px;
      padding: 6px 8px;
    }

    .derivation-node-clickable {
      cursor: pointer;
      transition: background-color 120ms ease, outline-color 120ms ease;
    }

    .derivation-node-clickable:hover {
      background: color-mix(in srgb, var(--vscode-editorHoverWidget-background) 70%, transparent 30%);
      outline: 1px solid var(--vscode-focusBorder);
    }

    .premises {
      display: inline-flex;
      align-items: flex-end;
      justify-content: center;
      gap: 16px;
      min-height: 14px;
    }

    .premises-empty {
      min-height: 12px;
    }

    .rule-line {
      width: 100%;
      min-width: 148px;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 8px;
    }

    .rule-bar {
      width: 100%;
      border-top: 2px solid currentColor;
    }

    .rule-name {
      font-variant: small-caps;
      letter-spacing: 0.04em;
      font-size: 12px;
      white-space: nowrap;
    }

    .conclusion {
      font-size: 17px;
      line-height: 1.45;
      text-align: center;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>Type derivation</h1>
    <p>${escapeHtml(subtitle)}</p>
  </div>
  <div class="canvas">
    <div class="derivation-root">
      ${renderNode(root)}
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const documentUri = ${JSON.stringify(response.documentUri ?? "")};

    for (const node of document.querySelectorAll(".derivation-node-clickable")) {
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        const rawRange = node.getAttribute("data-range");
        if (!rawRange) {
          return;
        }

        try {
          vscode.postMessage({
            type: "revealRange",
            uri: documentUri,
            range: JSON.parse(rawRange),
          });
        } catch {
          // ignore malformed range payloads
        }
      });
    }
  </script>
</body>
</html>`;
}

function getPlaceholderHtml(
  webview: vscode.Webview,
  title: string,
  message: string
): string {
  const nonce = String(Date.now());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }

    .card {
      max-width: 520px;
      padding: 20px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 18px;
    }

    p {
      margin: 0;
      opacity: 0.8;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    void vscode;
  </script>
</body>
</html>`;
}

async function requestTypeDerivation(
  client: LanguageClient,
  editor: vscode.TextEditor
): Promise<TypeDerivationRequestResult> {
  return client.sendRequest<TypeDerivationRequestResult>(
    STELLA_TYPE_DERIVATION_REQUEST,
    {
      uri: editor.document.uri.toString(),
      position: {
        line: editor.selection.active.line,
        character: editor.selection.active.character,
      },
    }
  );
}

async function openAndRevealRange(
  uri: string,
  range: AnalysisRange
): Promise<void> {
  const targetUri = vscode.Uri.parse(uri);
  const document = await vscode.workspace.openTextDocument(targetUri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: true,
  });

  const vscodeRange = toVscodeRange(range);
  if (!vscodeRange) {
    return;
  }

  editor.revealRange(vscodeRange, vscode.TextEditorRevealType.InCenter);
  editor.setDecorations(highlightDecorationType, [vscodeRange]);
}

async function refreshPanel(client: LanguageClient): Promise<void> {
  if (!currentPanel) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "stella") {
    currentPanel.webview.html = getPlaceholderHtml(
      currentPanel.webview,
      "Type derivation",
      "Open a Stella file and place the cursor on an expression to inspect the derivation tree."
    );
    return;
  }

  try {
    const response = await requestTypeDerivation(client, editor);

    if (!response?.root) {
      currentPanel.webview.html = getPlaceholderHtml(
        currentPanel.webview,
        "No derivation available",
        "The Stella language server did not return a derivation for the current cursor position."
      );
      return;
    }

    const subtitle = `${editor.document.fileName.split(/[/\\\\]/).pop() ?? editor.document.fileName} · cursor at ${editor.selection.active.line + 1}:${editor.selection.active.character + 1} · click any rule to highlight its source fragment`;
    currentPanel.webview.html = getHtml(currentPanel.webview, response, subtitle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentPanel.webview.html = getPlaceholderHtml(
      currentPanel.webview,
      "Failed to build type derivation",
      message
    );
  }
}

function scheduleRefresh(client: LanguageClient): void {
  if (!currentPanel || !currentPanel.visible) {
    return;
  }

  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    void refreshPanel(client);
  }, 120);
}

function disposePanelState(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  for (const disposable of panelDisposables) {
    disposable.dispose();
  }
  panelDisposables = [];
  currentPanel = undefined;
}

function ensurePanel(
  context: vscode.ExtensionContext,
  client: LanguageClient
): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
    return currentPanel;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "stellaTypeDerivation",
    "Stella Type Derivation",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panelDisposables.push(
    currentPanel.onDidDispose(() => {
      disposePanelState();
    }),

    currentPanel.onDidChangeViewState((event) => {
      if (event.webviewPanel.visible && currentClient) {
        void refreshPanel(currentClient);
      }
    }),

    currentPanel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }

      const payload = message as {
        type?: string;
        uri?: string;
        range?: AnalysisRange;
      };

      if (
        payload.type === "revealRange" &&
        payload.uri &&
        payload.range
      ) {
        try {
          await openAndRevealRange(payload.uri, payload.range);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`Failed to reveal source fragment: ${text}`);
        }
      }
    }),

    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor && currentClient) {
        scheduleRefresh(currentClient);
      }
    }),

    vscode.window.onDidChangeActiveTextEditor(() => {
      if (currentClient) {
        scheduleRefresh(currentClient);
      }
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document && currentClient) {
        scheduleRefresh(currentClient);
      }
    })
  );

  context.subscriptions.push(currentPanel, ...panelDisposables);
  return currentPanel;
}

export async function showTypeDerivationPanel(
  client: LanguageClient,
  context: vscode.ExtensionContext
): Promise<void> {
  currentClient = client;
  ensurePanel(context, client);
  await refreshPanel(client);
}