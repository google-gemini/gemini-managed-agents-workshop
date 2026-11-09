---
name: pr-review
description: Engineering pull request review principles, severity criteria, security checklist, and structured verdict rubric. Load whenever reviewing a GitHub pull request or diff.
---

# Pull Request Review Principles

Apply these engineering code review principles whenever evaluating a pull request via GitHub MCP.

## 1. Core Principle

Approve a pull request once it definitely improves the overall code health of the repository, even if it is not perfect. Focus on substantive defects over stylistic bikeshedding.

## 2. What to Check (In Priority Order)

1. **Correctness & Edge Cases**:
   - Does the diff actually do what the PR description and linked issue claim?
   - Check off-by-one boundaries, `null` / empty inputs, error handling, concurrency/async cancellation, and backward compatibility.
2. **Security & Trust Boundaries**:
   - Check authz/authn checks, secret handling, injection vectors (SQL, shell, path traversal, SSRF, XSS), and untrusted user or external API inputs.
3. **Tests & Verification**:
   - Are new behaviors and bug fixes covered by focused unit or integration tests in the diff?
   - Would the tests actually fail if the production fix were reverted?
4. **Clarity & Complexity**:
   - Flag unnecessary abstractions, dead code, duplicated state, or confusing naming that hurts future readers.

## 3. Comment Discipline

- Cite exact `file/path.ext` (and line or function names from the diff) for every finding.
- Label severity clearly:
  - **[Blocker]**: Correctness bug, security vulnerability, data loss, or broken API contract. Must fix before merge.
  - **[Nit]**: Non-blocking readability, naming, or minor cleanup suggestion.
- Explain *why* an issue matters and suggest a concrete fix in 1–2 sentences.
- If no substantive issues exist, explicitly write `No blocking issues found.` rather than inventing artificial nits.

## 4. Required Review Output

Structure every PR review with these three sections:

### Summary
2–3 sentences stating what `owner/repo#<pr>` changes and why.

### Findings
Bullet list of `[Blocker]` or `[Nit]` items with `path` references and concrete fixes, or `No blocking issues found.`

### Verdict
One of `APPROVE`, `APPROVE WITH NITS`, or `REQUEST CHANGES` followed by a one-sentence rationale.
