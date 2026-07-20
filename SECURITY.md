# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.8.x   | ✓         |
| < 1.8   | ✗         |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **chris@voodootikigod.com** with:
- A description of the vulnerability
- Steps to reproduce
- Potential impact

You will receive a response within 72 hours. If the issue is confirmed, a patch will be released as soon as possible (target: within 7 days for critical issues).

## Scope

This tool executes LLM calls and reads local files. Relevant attack surfaces:

- **API key exposure**: keys are read from environment variables and never written to disk or logged.
- **Path traversal**: the survey phase uses `lstat` when walking non-git directories, skipping symbolic links entirely. Git repositories use `git ls-files` and never walk the filesystem directly. The validate phase follows symlinks but constrains traversal via `realpath` containment checks — only paths that resolve inside the base directory are visited.
- **Arbitrary code execution**: the tool does not `eval` or `exec` content from scanned files.
