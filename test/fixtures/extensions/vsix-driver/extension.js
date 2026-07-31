const vscode = require("vscode");
const fs = require("fs");

async function runSmoke() {
  const fixture = process.env.INLINE_SQL_VSIX_SMOKE_FIXTURE;
  const resultPath = process.env.INLINE_SQL_VSIX_SMOKE_RESULT;
  if (typeof fixture !== "string" || typeof resultPath !== "string") {
    throw new Error("VSIX smoke environment is incomplete");
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixture));
  const editor = await vscode.window.showTextDocument(document);
  const before = document.getText();
  await vscode.commands.executeCommand("inlineSql.formatAll");
  const formatted = document.getText();
  if (formatted === before || !formatted.includes("SELECT")) {
    throw new Error("installed VSIX did not format the fixture");
  }
  await vscode.commands.executeCommand("undo");
  if (document.getText() !== before || editor.document !== document) {
    throw new Error("installed VSIX did not provide one undo");
  }
  fs.writeFileSync(resultPath, JSON.stringify({ ok: true }), { encoding: "utf8", flag: "wx" });
  await vscode.commands.executeCommand("workbench.action.quit");
}

function activate() {
  setTimeout(() => {
    void runSmoke().catch((error) => {
      const resultPath = process.env.INLINE_SQL_VSIX_SMOKE_RESULT;
      if (typeof resultPath === "string") {
        try {
          fs.writeFileSync(resultPath, JSON.stringify({ ok: false }), { encoding: "utf8", flag: "wx" });
        } catch {}
      }
      console.error("VSIX smoke failed");
      void vscode.commands.executeCommand("workbench.action.quit");
    });
  }, 100);
}

module.exports = { activate };
