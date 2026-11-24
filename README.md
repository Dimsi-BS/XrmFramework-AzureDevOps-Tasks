# XrmFramework Azure DevOps tasks

The Azure Pipelines tasks of the **XrmFramework DevOps tasks** extension, for deploying an
[XrmFramework](https://github.com/Dimsi-BS/XrmFramework) solution to Dataverse.

How to use the tasks in a pipeline is described in [overview.md](overview.md), which is also the
extension's page on the Visual Studio Marketplace.

## Layout

| Path | Content |
| --- | --- |
| `Tasks/<Task>/` | One folder per task: `task.json`, `index.ts`, and the `node_modules` it ships with |
| `Tasks/Shared/` | Code shared between tasks, bundled into each task that imports it |
| `scripts/build-tasks.js` | Type-checks every task, then bundles its `index.ts` into `index.js` |
| `vss-extension.json` | The extension manifest |

## Building

Node 20 or later.

```bash
npm ci
for manifest in Tasks/*/package.json; do (cd "$(dirname "$manifest")" && npm ci --omit=dev); done
npm run build
```

`npm run build` type-checks, bundles and lints every task. `npm run package:tasks` then writes the
`.vsix` to `dist/`.

The [Build](.github/workflows/build.yml) workflow does the same on every push and pull request to
`main`, and keeps the `.vsix` as an artifact of the run.

## Releasing

Bump the `version` of every task whose behaviour changed in its `task.json`, and the extension's in
`vss-extension.json`; the Marketplace rejects a version it has already seen. Merge to `main`, then
push a tag named after the extension version:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

The [Publish](.github/workflows/publish.yml) workflow builds the `.vsix`, waits for approval in the
`marketplace` environment, and publishes it under the `Dimsi` publisher through the Marketplace's
Trusted Publishing: no PAT is stored anywhere. It refuses a tag that does not match the version in
`vss-extension.json`.

Trusted Publishing works only because the `Dimsi` publisher has a policy naming this repository,
the `publish.yml` workflow and the `marketplace` environment. Renaming any of them means updating
that policy first.
