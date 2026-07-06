# Release Validation

Valtaris Glue now treats repository validation as a mandatory release gate for
every pull request and every direct push to `main`.

## Trigger points

- `pull_request` — validates proposed changes before merge.
- `push` on `main` — re-validates the exact branch tip that is eligible for release.

## Required checks

The `Release Gate` workflow blocks merges when any of these commands fail:

- `npm run lint`
- `npm test`
- `npm run test:runtime`
- `npm run build`

The same workflow also enforces:

- `npm audit --audit-level=high`
- repository secret scanning with `detect-secrets`

The separate `CodeQL` workflow runs JavaScript/TypeScript analysis on the same
`pull_request` and `push` events.

## Retained artifacts

The validation workflow uploads and retains:

- test result logs plus JUnit XML output
- coverage output from `npm run test:coverage`
- production build logs

Artifacts are retained for 14 days so failed runs can be investigated without
rerunning the pipeline.

## Failure handling

When a required check fails:

1. Open the failed workflow run in GitHub Actions.
2. Download the retained artifacts for test logs, coverage output, or build logs.
3. Fix the failing validation locally with the same `npm` commands used in CI.
4. Push the corrective change and wait for the required checks to pass again.

Security failures should be handled before any merge:

- `npm audit` failures require dependency remediation or an intentional version update.
- secret scan failures require removing or rotating the exposed value before retrying.
- CodeQL failures require either a localized fix or a documented false-positive review in GitHub code scanning.

## Branch protection assumptions

This repository assumes GitHub branch protection is enabled on `main` with:

- pull requests required before merge
- required status checks enabled and set to stay up to date
- direct pushes restricted except for explicitly approved automation/users
- administrators included in the protection policy

The required checks should be configured as:

- `Release Gate / validate`
- `Release Gate / audit`
- `Release Gate / secret-scan`
- `CodeQL / analyze-javascript-typescript`
