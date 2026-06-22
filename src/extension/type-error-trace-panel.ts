import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node.js";
import type { AnalysisRange } from "../shared/analysis/analysis-types.js";
import type {
  TypeErrorTraceNode,
  TypeErrorTraceView,
} from "../shared/analysis/type-error-trace-types.js";
import type {
  TypeErrorTraceRequestDiagnostic,
  TypeErrorTraceRequestResult,
} from "../shared/lsp/type-error-trace-protocol.js";
import { STELLA_TYPE_ERROR_TRACE_REQUEST } from "../shared/lsp/type-error-trace-protocol.js";
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

function normalizeDiagnosticText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isParserNoiseMessage(message: string): boolean {
  const normalized = normalizeDiagnosticText(message);
  return (
    /^Expecting:/i.test(normalized) ||
    /possible Token sequences?/i.test(normalized) ||
    /but found:/i.test(normalized) ||
    /mismatched input/i.test(normalized) ||
    /no viable alternative/i.test(normalized) ||
    /extraneous input/i.test(normalized)
  );
}

function isTraceableTypeDiagnostic(diagnostic: vscode.Diagnostic): boolean {
  if (diagnostic.severity !== vscode.DiagnosticSeverity.Error) {
    return false;
  }

  if (diagnostic.source && /parser|syntax/i.test(diagnostic.source)) {
    return false;
  }

  const message = normalizeDiagnosticText(diagnostic.message);
  if (isParserNoiseMessage(message)) {
    return false;
  }

  return (
    /return type of function/i.test(message) ||
    /expected\s+.+\s+but\s+(?:got|found)\s+.+/i.test(message) ||
    /actual\s+type\s+.+,\s*expected\s+.+/i.test(message) ||
    /type/i.test(message)
  );
}

function getReadableDiagnosticMessage(diagnostic: TypeErrorTraceView["diagnostic"]): string {
  const message = normalizeDiagnosticText(diagnostic.message);

  if (diagnostic.expectedType && diagnostic.actualType) {
    return `Type mismatch: expected ${diagnostic.expectedType}, got ${diagnostic.actualType}.`;
  }

  if (/return type of function/i.test(message)) {
    return "Function body does not match the declared return type.";
  }

  if (isParserNoiseMessage(message)) {
    return "Syntax error. Error trace is shown only for typing diagnostics.";
  }

  return message;
}

function diagnosticToRequest(
  diagnostic: vscode.Diagnostic
): TypeErrorTraceRequestDiagnostic {
  return {
    message: diagnostic.message,
    severity: diagnostic.severity,
    range: {
      start: {
        line: diagnostic.range.start.line,
        character: diagnostic.range.start.character,
      },
      end: {
        line: diagnostic.range.end.line,
        character: diagnostic.range.end.character,
      },
    },
  };
}

function rangeContainsPosition(range: vscode.Range, position: vscode.Position): boolean {
  return (
    position.isAfterOrEqual(range.start) && position.isBeforeOrEqual(range.end)
  );
}

function selectRelevantDiagnostic(
  editor: vscode.TextEditor
): vscode.Diagnostic | undefined {
  const diagnostics = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);

  const typeDiagnostics = diagnostics.filter((diagnostic) =>
    isTraceableTypeDiagnostic(diagnostic)
  );

  if (typeDiagnostics.length === 0) {
    return undefined;
  }

  const cursor = editor.selection.active;

  const exactMatch = typeDiagnostics.find((diagnostic) =>
    rangeContainsPosition(diagnostic.range, cursor)
  );
  if (exactMatch) {
    return exactMatch;
  }

  const sameLine = typeDiagnostics.find(
    (diagnostic) =>
      diagnostic.range.start.line <= cursor.line &&
      diagnostic.range.end.line >= cursor.line
  );
  if (sameLine) {
    return sameLine;
  }

  return typeDiagnostics[0];
}

function renderTraceNode(node: TypeErrorTraceNode): string {
  const clickableClass = node.range ? " trace-node-clickable" : "";
  const focusedClass = node.isFocused ? " trace-node-focused" : "";
  const errorClass = node.isErrorSource ? " trace-node-error" : "";
  const rangeAttribute = node.range ? `data-range="${encodeRange(node.range)}"` : "";

  const badges: string[] = [];
  if (node.isFocused) {
    badges.push('<span class="badge">cursor</span>');
  }
  if (node.isErrorSource) {
    badges.push('<span class="badge badge-error">error source</span>');
  }

  const children = node.children
    .map(
      (child) => `
        <div class="trace-arrow">↓</div>
        ${renderTraceNode(child)}
      `
    )
    .join("");

  return `
    <div class="trace-segment">
      <div class="trace-node${clickableClass}${focusedClass}${errorClass}" ${rangeAttribute}>
        <div class="trace-node-topline">
          <div class="trace-rule">${escapeHtml(node.ruleName)}</div>
          <div class="trace-badges">${badges.join("")}</div>
        </div>
        <div class="trace-judgement">${escapeHtml(node.judgement)}</div>
        ${node.detail ? `<div class="trace-detail">${escapeHtml(node.detail)}</div>` : ""}
      </div>
      ${children}
    </div>
  `;
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
      max-width: 560px;
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
      opacity: 0.82;
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

function getHtml(webview: vscode.Webview, response: TypeErrorTraceView): string {
  const nonce = String(Date.now());
  const diagnostic = response.diagnostic;
  const hasExpectedActual = diagnostic.expectedType && diagnostic.actualType;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Type error trace</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    body {
      margin: 0;
      padding: 18px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }

    .toolbar,
    .diagnostic-card,
    .trace-node {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
    }

    .toolbar {
      padding: 12px 14px;
      margin-bottom: 14px;
    }

    .toolbar h1 {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 600;
    }

    .toolbar p {
      margin: 0;
      font-size: 12px;
      opacity: 0.8;
    }

    .diagnostic-card {
      padding: 14px 16px;
      margin-bottom: 18px;
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
    }

    .diagnostic-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.75;
      margin-bottom: 6px;
    }

    .diagnostic-message {
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 10px;
    }

    .diagnostic-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .meta-pill,
    .badge {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background) 12%);
    }

    .badge-error {
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
    }

    .trace-root {
      display: flex;
      justify-content: center;
      padding-bottom: 20px;
    }

    .trace-segment {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      width: min(1100px, 100%);
    }

    .trace-node {
      width: min(1000px, 100%);
      padding: 14px 16px;
      transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
    }

    .trace-node-clickable {
      cursor: pointer;
    }

    .trace-node-clickable:hover {
      background: color-mix(in srgb, var(--vscode-editorHoverWidget-background) 70%, transparent 30%);
      border-color: var(--vscode-focusBorder);
      transform: translateY(-1px);
    }

    .trace-node-focused {
      border-color: var(--vscode-focusBorder);
    }

    .trace-node-error {
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-focusBorder));
    }

    .trace-node-topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }

    .trace-rule {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .trace-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .trace-judgement {
      font-family: "Times New Roman", Georgia, serif;
      font-size: 24px;
      line-height: 1.35;
      word-break: break-word;
      margin-bottom: 8px;
    }

    .trace-detail {
      font-size: 13px;
      line-height: 1.55;
      opacity: 0.86;
    }

    .trace-arrow {
      font-size: 28px;
      line-height: 1;
      opacity: 0.7;
      user-select: none;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>Type error trace</h1>
    <p>Цепочка правил и подвыражений, которая приводит к текущей ошибке типизации.</p>
  </div>

  <div class="diagnostic-card">
    <div class="diagnostic-label">diagnostic</div>
    <div class="diagnostic-message">${escapeHtml(getReadableDiagnosticMessage(diagnostic))}</div>
    <div class="diagnostic-meta">
      ${
        hasExpectedActual
          ? `<span class="meta-pill">expected: ${escapeHtml(diagnostic.expectedType ?? "")}</span>
             <span class="meta-pill">actual: ${escapeHtml(diagnostic.actualType ?? "")}</span>`
          : ""
      }
    </div>
  </div>

  <div class="trace-root">
    ${renderTraceNode(response.root)}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const documentUri = ${JSON.stringify(response.documentUri ?? "")};

    for (const node of document.querySelectorAll(".trace-node-clickable")) {
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

async function requestTypeErrorTrace(
  client: LanguageClient,
  editor: vscode.TextEditor,
  diagnostic: vscode.Diagnostic
): Promise<TypeErrorTraceRequestResult> {
  return client.sendRequest<TypeErrorTraceRequestResult>(
    STELLA_TYPE_ERROR_TRACE_REQUEST,
    {
      uri: editor.document.uri.toString(),
      position: {
        line: editor.selection.active.line,
        character: editor.selection.active.character,
      },
      diagnostic: diagnosticToRequest(diagnostic),
    }
  );
}

async function refreshPanel(client: LanguageClient): Promise<void> {
  if (!currentPanel) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "stella") {
    currentPanel.webview.html = getPlaceholderHtml(
      currentPanel.webview,
      "Type error trace",
      "Open a Stella file and place the cursor on a line with a type error."
    );
    return;
  }

  const diagnostic = selectRelevantDiagnostic(editor);
  if (!diagnostic) {
    currentPanel.webview.html = getPlaceholderHtml(
      currentPanel.webview,
      "No type diagnostics here",
      "Для текущей позиции не найдено понятной ошибки типизации. Синтаксические parser errors теперь не попадают в error trace: поставь курсор на выражение с type mismatch или ошибкой return type."
    );
    return;
  }

  try {
    const response = await requestTypeErrorTrace(client, editor, diagnostic);

    if (!response?.root) {
      currentPanel.webview.html = getPlaceholderHtml(
        currentPanel.webview,
        "No trace available",
        "Language server did not return a type error trace for the selected diagnostic."
      );
      return;
    }

    currentPanel.webview.html = getHtml(currentPanel.webview, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentPanel.webview.html = getPlaceholderHtml(
      currentPanel.webview,
      "Failed to build type error trace",
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
    "stellaTypeErrorTrace",
    "Stella Type Error Trace",
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

      if (payload.type === "revealRange" && payload.uri && payload.range) {
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
    }),

    vscode.languages.onDidChangeDiagnostics(() => {
      if (currentClient) {
        scheduleRefresh(currentClient);
      }
    })
  );

  context.subscriptions.push(currentPanel, ...panelDisposables);
  return currentPanel;
}

export async function showTypeErrorTracePanel(
  client: LanguageClient,
  context: vscode.ExtensionContext
): Promise<void> {
  currentClient = client;
  ensurePanel(context, client);
  await refreshPanel(client);
}
