# Third-party notices

Inline SQL Toolkit includes the third-party components below. Their authors and
copyright holders retain their rights; this project does not claim ownership of
their source or license text. Copies of the required notices are packaged in
the VSIX under `third_party/`.

## `sqlparse` 0.5.5

The Python formatter uses the vendored `sqlparse` 0.5.5 wheel under the
BSD-3-Clause license. The exact wheel provenance is:

- PyPI project: <https://pypi.org/project/sqlparse/0.5.5/>
- Pinned wheel: <https://files.pythonhosted.org/packages/49/4b/359f28a903c13438ef59ebeee215fb25da53066db67b305c125f1c6d2a25/sqlparse-0.5.5-py3-none-any.whl>
- Version: `0.5.5`
- Wheel SHA-256: `12a08b3bf3eec877c519589833aed092e2444e68240a3577e8e26148acc7b1ba`
- Upstream project: <https://github.com/andialbrecht/sqlparse>

The complete BSD-3-Clause license, AUTHORS record, source metadata, and
per-file SHA-256 inventory are in
[`third_party/sqlparse/`](third_party/sqlparse/) in the source repository and
are copied into the packaged VSIX. The runtime tree is checked against the
pinned inventory before packaging.

## `@vscode/python-extension` 1.0.5

The extension bundles Microsoft's Python Extension API facade through esbuild.
It is distributed under the MIT license. Exact provenance links are:

- npm package: <https://www.npmjs.com/package/@vscode/python-extension>
- Source repository path: <https://github.com/microsoft/vscode/tree/main/pythonExtensionApi>
- Version: `1.0.5`

The complete MIT notice and source record are in
[`third_party/vscode-python-extension/`](third_party/vscode-python-extension/)
and are copied into the packaged VSIX. The facade is a third-party component;
its inclusion does not transfer ownership to this project.

## Project license

The Inline SQL Toolkit source and original documentation are provided under the
MIT license in [`LICENSE`](LICENSE). This project license does not replace or
alter the third-party licenses above.
