# XrmFramework DevOps tasks

Pipeline tasks for deploying an [XrmFramework](https://github.com/Dimsi-BS/XrmFramework) solution
to Dataverse.

## Deploying without a secret

A Dataverse deployment usually means putting a client secret in the pipeline. These tasks do not
need one: with a service connection in **Workload Identity federation** mode, the task obtains an
OIDC token for the connection and the XrmFramework CLI exchanges it for a Dataverse token.

That exchange is why these are tasks rather than a `script:` step. Azure DevOps makes a service
connection available only to a job that
[consumes it as a task input](https://learn.microsoft.com/azure/devops/pipelines/process/about-resources#use-resources-to-enhance-security),
so only a task can read the connection or mint a token for it — a script step gets a token scoped to
the pipeline instead, or none at all.

```yaml
steps:
- task: XrmFrameworkCliInstall@1

- task: XrmFrameworkDeployPlugins@1
  inputs:
    authenticationType: PowerPlatformSPN
    PowerPlatformSPN: <your Power Platform service connection>
    PluginProjectPath: $(Build.SourcesDirectory)/Plugins
    Configuration: Release

- task: XrmFrameworkDeployWebresources@1
  inputs:
    authenticationType: PowerPlatformSPN
    PowerPlatformSPN: <your Power Platform service connection>
    WebresourcesProjectPath: $(Build.SourcesDirectory)/Webresources
```

One-off setup, outside the pipeline: create the service connection in *Workload Identity
federation* mode, copy the **Issuer** and **Subject identifier** it shows into a federated
credential on the Entra app registration (*Certificates & secrets* → *Federated credentials* →
*Other issuer*), and add that application as an **application user** in the Dataverse environment
with a security role.

## Which environment is deployed to

Every task takes the environment URL from its service connection, so nothing has to be set for the
common case. The `Environment` input overrides it, and defaults to `$(BuildTools.EnvironmentUrl)` —
the variable the Power Platform *Create Environment* task publishes — so a pipeline that provisions
an environment first deploys into that one. When that variable is not set the connection's own URL
applies.

## Tasks

### XrmFramework CLI installer

Installs `XrmFramework.Cli` as a .NET tool in a folder of its own and prepends it to PATH, so the
deployment tasks — and any script in the job — can call `xrmframework`. Run it once per job.

A version can be pinned; left empty it takes the latest **stable** release. A prerelease is
installed only by naming its version, so a pipeline never moves onto a beta on its own. It installs
with `dotnet tool update`, so a job that runs twice does not fail on an already-installed tool.

### XrmFramework plugin deployment

Deploys plugins, Custom APIs and workflow activities. Two routes, in this order:

1. **the CLI**, when the job installed it — `xrmframework deploy plugins`. The only route that can
   federate.
2. **the scaffolded deploy project executable**, as this task has always done, so a pipeline written
   before the CLI existed keeps working untouched. It reads `Config/connectionStrings.config` and
   cannot federate; the task says so when the connection would have allowed it.

Only `PluginProjectPath` and `Configuration` are needed for either route: the assembly is found under
the project's build output, and the project name defaults to the project folder's. `DllPath`,
`Project` and `PackagePath` override that when the layout is unusual.

### XrmFramework webresource deployment

The same two routes for `xrmframework deploy webresources`. Build the TypeScript before it runs.

## Service connections that carry a secret

A connection that is not federated still works: the task reads its application id and secret and
hands them to the CLI through the environment — never a command line, which is visible to every
process on the agent — so no `connectionStrings.config` is written at all. The task warns that a
secret has to be stored and rotated and can leak, and that converting the connection to federation
removes it entirely.

Only the executable route still needs `Config/connectionStrings.config`.

### XrmFramework connectionStrings creation

Writes `Config/connectionStrings.config` from a secret-based service connection. Needed only for the
executable route — both CLI routes supply their own credentials.

### Power Apps environment runtime state

Enables or disables a Power Platform environment.
