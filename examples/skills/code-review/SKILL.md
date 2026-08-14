---
name: code-review
description: Review a change for correctness, security boundaries, and missing tests.
---

# Code review workflow

1. Inspect the changed files and their callers.
2. Check workspace path confinement, approval boundaries, and command execution safety.
3. Identify concrete defects before style suggestions.
4. Verify each finding against the current file content.
5. Report findings by severity with file and line references.
