import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node.js";
import type { AstRequestResult } from "../shared/lsp/ast-protocol.js";
import { STELLA_AST_REQUEST } from "../shared/lsp/ast-protocol.js";

export function registerShowAstJsonCommand(
  client: LanguageClient
): vscode.Disposable {
  return vscode.commands.registerCommand("stella.showAstJson", async () => {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.document.languageId !== "stella") {
      await vscode.window.showInformationMessage(
        "Открой файл Stella, чтобы показать AST."
      );
      return;
    }

    try {
      const ast = await client.sendRequest<AstRequestResult>(
        STELLA_AST_REQUEST,
        {
          uri: editor.document.uri.toString(),
        }
      );

      if (!ast) {
        await vscode.window.showWarningMessage(
          "Не удалось получить AST для текущего документа."
        );
        return;
      }

      const jsonText = JSON.stringify(ast, null, 2);

      const jsonDocument = await vscode.workspace.openTextDocument({
        language: "json",
        content: jsonText,
      });

      await vscode.window.showTextDocument(jsonDocument, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";

      await vscode.window.showErrorMessage(
        `Ошибка при получении AST: ${message}`
      );
    }
  });
}