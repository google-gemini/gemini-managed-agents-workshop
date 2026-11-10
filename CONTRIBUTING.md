# Contributing

Contributions to this workshop repository are welcome within the scope below.

## Contributor License Agreement

Contributions to this project must be accompanied by a [Contributor License Agreement](https://cla.developers.google.com/) (CLA). You (or your employer) retain the copyright to your contribution; this gives Google permission to use and redistribute your contributions as part of the project.

If you haven't signed an agreement before, visit <https://cla.developers.google.com/> to check your current agreements or sign a new one. You generally only need to submit a CLA once.

## Contribution scope

This repository backs a structured 4-step hands-on workshop split across two branches:
- `main` is the minimal starter template used during the session.
- `solution` is the completed reference implementation across all 4 steps.

Pull requests for bug fixes, typo fixes, security fixes, and SDK or dependency compatibility updates are welcome. External feature additions are generally not accepted; if you want to propose a larger change, open an issue first to discuss scope before sending a pull request. When a fix applies to shared code (such as `web/`, `slides/`, or shared `server/` modules), note whether both `main` and `solution` need the update.

Before opening a pull request, run the local checks:

```bash
bun run typecheck && bun run build && bun test
```

## Code reviews

All submissions, including submissions by project members, require review through GitHub pull requests.

## Community guidelines

This project follows [Google's Open Source Community Guidelines](https://opensource.google/conduct/).
