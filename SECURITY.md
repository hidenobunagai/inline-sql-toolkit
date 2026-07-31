# Security policy

## Supported versions

Security fixes are assessed against the current `0.1.x` release line. Use the
latest `0.1.x` release before reporting a vulnerability; older versions may no
longer receive fixes. The current release is `0.1.0`.

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
highlighting only. In a trusted workspace the extension sends a bounded,
versioned request to its local one-shot Python helper; document text is not
written to disk or emitted in logs.
