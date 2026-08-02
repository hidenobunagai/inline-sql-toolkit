import * as vscode from "vscode";

import { findSqlLiterals, tokenizeSqlLiteral } from "./semantic-tokens.js";

/** Register diagnostics commands that dump the active cell's state. */
export function registerDebugCommands(
  context: vscode.ExtensionContext,
): readonly vscode.Disposable[] {
  const channel = vscode.window.createOutputChannel("Inline SQL Toolkit (Debug)");
  context.subscriptions.push(channel);
  const command = vscode.commands.registerCommand("inlineSql.debugSemanticTokens", () => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      channel.appendLine("No active text editor.");
      channel.show();
      return;
    }
    const document = editor.document;
    const text = document.getText();
    channel.appendLine(`uri: ${document.uri.toString()}`);
    channel.appendLine(`scheme: ${document.uri.scheme}`);
    channel.appendLine(`languageId: ${document.languageId}`);
    channel.appendLine(`text length: ${text.length}`);
    channel.appendLine(`text head: ${JSON.stringify(text.slice(0, 300))}`);
    const literals = findSqlLiterals(text);
    channel.appendLine(`sql literals: ${literals.length}`);
    for (const literal of literals) {
      channel.appendLine(
        `  literal ${literal.start}-${literal.end}: ${JSON.stringify(
          text.slice(literal.start, literal.end).slice(0, 120),
        )}`,
      );
      const tokens = tokenizeSqlLiteral(literal, text);
      channel.appendLine(`  tokens: ${tokens.length}`);
      for (const token of tokens.slice(0, 40)) {
        channel.appendLine(
          `    ${token.type} ${JSON.stringify(
            text.slice(token.start, token.start + token.length),
          )}`,
        );
      }
    }
    channel.show();
  });
  context.subscriptions.push(command);
  return [channel, command];
}
