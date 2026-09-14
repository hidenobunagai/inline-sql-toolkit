# Security policy

## Supported versions

Security fixes are assessed against the latest published release. Use the
newest version before reporting a vulnerability; older versions may no longer
receive fixes. The current version is listed in the changelog.

## Private reporting

Please do not disclose security vulnerabilities in public issues, discussions,
or pull requests. Report privately through the repository's configured GitHub
security advisory UI: **Security → Advisories → Report a vulnerability**. This
policy intentionally does not publish an email address or invent another
contact channel.

Include the affected version, the smallest reproducible description, impact,
and any relevant configuration. Do not include credentials, tokens, customer
data, private source, or other secrets. If source is necessary to reproduce the
issue, redact it and describe only the smallest safe shape.

## Security boundaries

Inline SQL Toolkit is designed to work offline. It does not execute SQL,
connect to a database, make network requests, run a shell command, collect
telemetry, or format automatically. In an untrusted workspace it provides
highlighting only. In a trusted workspace the extension formats the detected
SQL in-process with the bundled `sql-formatter` layout engine; document text is
not written to disk or emitted in logs.
