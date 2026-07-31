const vscode = require("vscode");

function activate(context) {
  let mode = "safe";
  const legend = new vscode.SemanticTokensLegend(["variable", "string"], []);
  const provider = {
    provideDocumentSemanticTokens(document) {
      const text = document.getText();
      const needle = mode === "overlap" ? "SELECT" : "query";
      const offset = text.indexOf(needle);
      const builder = new vscode.SemanticTokensBuilder(legend);
      if (offset >= 0) {
        builder.push(
          new vscode.Range(
            document.positionAt(offset),
            document.positionAt(offset + needle.length),
          ),
          mode === "overlap" ? "string" : "variable",
          [],
        );
      }
      return builder.build();
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      [{ language: "python" }, { language: "mo-python" }],
      provider,
      legend,
    ),
    vscode.commands.registerCommand("inlineSql.semanticProbe.setMode", (value) => {
      if (value !== "safe" && value !== "overlap") {
        throw new Error("invalid semantic probe mode");
      }
      mode = value;
    }),
  );
}

module.exports = { activate };
