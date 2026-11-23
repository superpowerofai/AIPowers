---
name: aipowers-code-review
description: "Review changes for correctness, regressions, security, maintainability, and missing tests. Use when task matches these triggers: code review, review this code, review changes, security review, review pull request."
---

<!-- AIPOWERS:MANAGED -->

# Code Review

This skill is maintained by AIPowers. Follow the workflow below when this skill applies.

## Activation details

- AIPowers skill ID: code-review
- Priority: 70
- Triggers: code review, review this code, review changes, security review, review pull request

## Instructions

Review the actual diff and surrounding code. Prioritize concrete defects: incorrect behavior, security issues, data loss, compatibility breaks, and missing regression coverage. Cite exact files and lines where possible. Separate blocking findings from suggestions. Do not invent issues or approve code whose behavior has not been understood.
