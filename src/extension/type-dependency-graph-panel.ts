import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node.js";
import type { AnalysisRange } from "../shared/analysis/analysis-types.js";
import type {
  TypeDependencyGraphNode,
} from "../shared/analysis/type-dependency-graph-types.js";
import type { TypeDependencyGraphRequestResult } from "../shared/lsp/type-dependency-graph-protocol.js";
import { STELLA_TYPE_DEPENDENCY_GRAPH_REQUEST } from "../shared/lsp/type-dependency-graph-protocol.js";
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

function renderLegend(): string {
  return `
    <div class="legend">
      <span><i class="dot dot-selected"></i>selected</span>
      <span><i class="dot dot-function"></i>function</span>
      <span><i class="dot dot-parameter"></i>parameter</span>
      <span><i class="dot dot-binding"></i>binding</span>
      <span><i class="dot dot-expression"></i>expression</span>
      <span><i class="dot dot-conflict"></i>type conflict</span>
    </div>
  `;
}

function renderNode(node: TypeDependencyGraphNode): string {
  const classes = [
    "graph-node",
    `kind-${node.kind}`,
    node.range ? "graph-node-clickable" : "",
    node.isConflict ? "is-conflict" : "",
    node.isFocused ? "is-focused" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const rangeAttribute = node.range ? `data-range="${encodeRange(node.range)}"` : "";

  return `
    <div class="${classes}" id="node-${escapeHtml(node.id)}" data-node-id="${escapeHtml(node.id)}" ${rangeAttribute}>
      <div class="graph-node-kind">${escapeHtml(node.kind)}</div>
      <div class="graph-node-label">${escapeHtml(node.label)}</div>
      ${node.typeLabel ? `<div class="graph-node-type">${escapeHtml(node.typeLabel)}</div>` : ""}
      ${node.detail ? `<div class="graph-node-detail">${escapeHtml(node.detail)}</div>` : ""}
    </div>
  `;
}

function renderColumns(nodes: TypeDependencyGraphNode[]): string {
  const grouped = new Map<number, TypeDependencyGraphNode[]>();
  for (const node of nodes) {
    const bucket = grouped.get(node.layer) ?? [];
    bucket.push(node);
    grouped.set(node.layer, bucket);
  }

  const layers = Array.from(grouped.keys()).sort((left, right) => left - right);

  return layers
    .map((layer) => {
      const layerNodes = grouped.get(layer) ?? [];
      return `
        <section class="graph-column" data-layer="${layer}">
          <div class="graph-column-label">L${layer}</div>
          <div class="graph-column-body">
            ${layerNodes.map((node) => renderNode(node)).join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function getHtml(
  webview: vscode.Webview,
  response: TypeDependencyGraphRequestResult
): string {
  const nonce = String(Date.now());
  if (!response) {
    return getPlaceholderHtml(
      webview,
      "No dependency graph available",
      "The Stella language server did not return dependency data for the current cursor position."
    );
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(response.title)}</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }

    .toolbar {
      margin-bottom: 16px;
      padding: 14px 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
    }

    .toolbar h1 {
      margin: 0 0 6px;
      font-size: 17px;
      line-height: 1.35;
    }

    .toolbar p {
      margin: 0;
      font-size: 12px;
      line-height: 1.55;
      opacity: 0.88;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 14px;
      margin-top: 12px;
      font-size: 11px;
      opacity: 0.86;
    }

    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
    }

    .dot-selected { background: color-mix(in srgb, var(--vscode-button-background) 75%, white 25%); }
    .dot-function { background: color-mix(in srgb, #4da3ff 70%, transparent 30%); }
    .dot-parameter { background: color-mix(in srgb, #65c466 70%, transparent 30%); }
    .dot-binding { background: color-mix(in srgb, #d8a657 75%, transparent 25%); }
    .dot-expression { background: color-mix(in srgb, var(--vscode-editorHoverWidget-background) 78%, white 22%); }
    .dot-conflict { background: color-mix(in srgb, var(--vscode-errorForeground) 82%, transparent 18%); }

    .canvas {
      position: relative;
      min-height: 420px;
      overflow: auto;
      padding: 20px 12px 24px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 14px;
      background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-sideBar-background) 4%);
    }

    .graph-shell {
      position: relative;
      min-width: max-content;
      min-height: 360px;
    }

    svg.graph-edges {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
      z-index: 0;
    }

    .graph-columns {
      position: relative;
      z-index: 1;
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(240px, 280px);
      gap: 28px;
      align-items: start;
    }

    .graph-column {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .graph-column-label {
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.62;
      padding-left: 4px;
    }

    .graph-column-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 220px;
    }

    .graph-node {
      padding: 12px 12px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 14px;
      background: color-mix(in srgb, var(--vscode-editorHoverWidget-background) 70%, transparent 30%);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
    }

    .graph-node-clickable {
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }

    .graph-node-clickable:hover {
      transform: translateY(-1px);
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.12);
    }

    .graph-node-kind {
      margin-bottom: 6px;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0.7;
    }

    .graph-node-label {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.45;
      word-break: break-word;
    }

    .graph-node-type {
      margin-top: 7px;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
      line-height: 1.45;
      color: color-mix(in srgb, var(--vscode-symbolIcon-typeForeground, var(--vscode-editor-foreground)) 78%, white 22%);
    }

    .graph-node-detail {
      margin-top: 8px;
      font-size: 11px;
      line-height: 1.45;
      opacity: 0.8;
      word-break: break-word;
    }

    .kind-selected {
      border-color: color-mix(in srgb, var(--vscode-button-background) 70%, transparent 30%);
      background: color-mix(in srgb, var(--vscode-button-background) 18%, var(--vscode-editor-background) 82%);
    }

    .kind-function {
      border-color: color-mix(in srgb, #4da3ff 60%, transparent 40%);
    }

    .kind-parameter {
      border-color: color-mix(in srgb, #65c466 60%, transparent 40%);
    }

    .kind-binding,
    .kind-case {
      border-color: color-mix(in srgb, #d8a657 58%, transparent 42%);
    }

    .graph-node.is-focused {
      box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 10px 26px rgba(0, 0, 0, 0.12);
    }

    .graph-node.is-conflict {
      border-color: color-mix(in srgb, var(--vscode-errorForeground) 70%, transparent 30%);
      background: color-mix(in srgb, var(--vscode-errorForeground) 9%, var(--vscode-editor-background) 91%);
    }

    .edge-label {
      font-size: 10px;
      fill: var(--vscode-editor-foreground);
      opacity: 0.78;
      paint-order: stroke;
      stroke: var(--vscode-editor-background);
      stroke-width: 4px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .edge-path {
      fill: none;
      stroke: color-mix(in srgb, var(--vscode-descriptionForeground, var(--vscode-editor-foreground)) 65%, transparent 35%);
      stroke-width: 1.6;
      opacity: 0.85;
    }

    .edge-path.conflict {
      stroke: color-mix(in srgb, var(--vscode-errorForeground) 80%, transparent 20%);
      stroke-width: 2;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>${escapeHtml(response.title)}</h1>
    <p>${escapeHtml(response.summary ?? "Dependencies are shown from left to right. Click any node to reveal its source fragment.")}</p>
    ${renderLegend()}
  </div>

  <div class="canvas">
    <div class="graph-shell" id="graph-shell">
      <svg class="graph-edges" id="graph-edges" aria-hidden="true">
        <defs>
          <marker id="arrow-head" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L0,6 L8,3 z" fill="currentColor"></path>
          </marker>
        </defs>
      </svg>
      <div class="graph-columns" id="graph-columns">
        ${renderColumns(response.nodes)}
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const documentUri = ${JSON.stringify(response.documentUri ?? "")};
    const edges = ${JSON.stringify(response.edges)};

    function createSvgElement(name) {
      return document.createElementNS("http://www.w3.org/2000/svg", name);
    }

    function drawEdges() {
      const shell = document.getElementById("graph-shell");
      const svg = document.getElementById("graph-edges");
      const columns = document.getElementById("graph-columns");
      if (!shell || !svg || !columns) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      svg.setAttribute("viewBox", "0 0 " + Math.ceil(shellRect.width) + " " + Math.ceil(shellRect.height));
      svg.querySelectorAll(".edge-path, .edge-label").forEach((node) => node.remove());

      for (const edge of edges) {
        const from = document.querySelector('[data-node-id="' + CSS.escape(edge.from) + '"]');
        const to = document.querySelector('[data-node-id="' + CSS.escape(edge.to) + '"]');
        if (!from || !to) {
          continue;
        }

        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();
        const startX = fromRect.right - shellRect.left;
        const startY = fromRect.top + fromRect.height / 2 - shellRect.top;
        const endX = toRect.left - shellRect.left;
        const endY = toRect.top + toRect.height / 2 - shellRect.top;
        const controlOffset = Math.max(40, Math.abs(endX - startX) * 0.45);
        const pathData = [
          "M " + startX + " " + startY,
          "C " + (startX + controlOffset) + " " + startY + ", " + (endX - controlOffset) + " " + endY + ", " + endX + " " + endY,
        ].join(" ");

        const path = createSvgElement("path");
        path.setAttribute("d", pathData);
        path.setAttribute("class", "edge-path" + (edge.isConflict ? " conflict" : ""));
        path.setAttribute("marker-end", "url(#arrow-head)");
        path.style.color = edge.isConflict
          ? getComputedStyle(document.body).getPropertyValue("--vscode-errorForeground") || "#ff6b6b"
          : getComputedStyle(document.body).color;
        svg.appendChild(path);

        if (edge.label) {
          const label = createSvgElement("text");
          label.setAttribute("class", "edge-label");
          label.setAttribute("x", String((startX + endX) / 2));
          label.setAttribute("y", String((startY + endY) / 2 - 6));
          label.setAttribute("text-anchor", "middle");
          label.textContent = edge.label;
          svg.appendChild(label);
        }
      }
    }

    for (const node of document.querySelectorAll(".graph-node-clickable")) {
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

    const resizeObserver = new ResizeObserver(() => drawEdges());
    resizeObserver.observe(document.getElementById("graph-columns"));
    window.addEventListener("resize", drawEdges);
    window.addEventListener("load", drawEdges);
    requestAnimationFrame(drawEdges);
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
      max-width: 560px;
      padding: 22px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 14px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 18px;
    }

    p {
      margin: 0;
      opacity: 0.84;
      line-height: 1.55;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  <script nonce="${nonce}">const vscode = acquireVsCodeApi(); void vscode;</script>
</body>
</html>`;
}

async function requestGraph(
  client: LanguageClient,
  editor: vscode.TextEditor
): Promise<TypeDependencyGraphRequestResult> {
  return client.sendRequest<TypeDependencyGraphRequestResult>(
    STELLA_TYPE_DEPENDENCY_GRAPH_REQUEST,
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
      "Type dependency graph",
      "Open a Stella file and place the cursor on an expression or function to inspect the type dependency graph."
    );
    return;
  }

  try {
    const response = await requestGraph(client, editor);
    if (!response) {
      currentPanel.webview.html = getPlaceholderHtml(
        currentPanel.webview,
        "No dependency graph available",
        "The current cursor position does not resolve to a Stella expression or function that can be visualized."
      );
      return;
    }

    currentPanel.webview.html = getHtml(currentPanel.webview, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentPanel.webview.html = getPlaceholderHtml(
      currentPanel.webview,
      "Failed to build dependency graph",
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
    "stellaTypeDependencyGraph",
    "Stella Type Dependency Graph",
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
    })
  );

  context.subscriptions.push(currentPanel, ...panelDisposables);
  return currentPanel;
}

export async function showTypeDependencyGraphPanel(
  client: LanguageClient,
  context: vscode.ExtensionContext
): Promise<void> {
  currentClient = client;
  ensurePanel(context, client);
  await refreshPanel(client);
}
