// Copyright (c) Dimsi. Licensed under the MIT License.

import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { XrmFrameworkCredentials, credentialEnvironment, inheritedEnvironment, resolveCredentials } from '../Shared/xrmframework-credentials';
import { input } from '../Shared/task-inputs';

/**
 * Deploys plugins, Custom APIs and workflow activities to the environment of a service connection.
 *
 * Two routes, in this order:
 *
 *  1. the **XrmFramework CLI**, when the job installed it. This is the one that can federate: being
 *     a task is what makes it possible at all, since Azure DevOps hands a service connection only
 *     to a job that consumes it as a task input, so only a task can obtain a token for it.
 *  2. the scaffolded **Deploy project executable**, as this task has always done. Kept so a
 *     pipeline written before the CLI existed keeps working untouched - it reads its credentials
 *     from `Config/connectionStrings.config` and cannot federate.
 */
async function run(): Promise<void> {
    try {
        const authenticationType = tl.getInput('authenticationType', true);
        const credentials = await resolveCredentials(authenticationType);

        const cli = findCli();

        if (cli) {
            await deployWithCli(cli, credentials);

            return;
        }

        await deployWithDeployProject(credentials);
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err instanceof Error ? err.message : String(err));
    }
}

async function deployWithCli(cli: string, credentials: XrmFrameworkCredentials): Promise<void> {
    const environmentUrl = input('Environment') || credentials.environmentUrl;

    if (!environmentUrl) {
        throw new Error('No environment URL: set it on the task, or on the service connection.');
    }

    const dll = input('DllPath') || discoverAssembly();
    const project = input('Project') || deriveProjectName();

    console.log(`Deploying ${dll} with the XrmFramework CLI`);

    const runner = tl.tool(cli)
        .arg(['deploy', 'plugins'])
        .arg(['--dll', dll])
        .arg(['--project', project])
        .arg(['--project-root', projectRoot()])
        .arg(['--environment', environmentUrl])
        .arg('--noprompt');

    const packagePath = input('PackagePath');

    if (packagePath) runner.arg(['--package', packagePath]);

    runner.arg(['--auth', authMode(credentials)]);
    runner.line(input('ExtraArguments') || '');

    const exitCode = await runner.exec({
        env: inheritedEnvironment(credentialEnvironment(credentials)),
        ignoreReturnCode: true,
    } as never);

    if (exitCode !== 0) {
        throw new Error(`xrmframework deploy plugins exited with code ${exitCode}.`);
    }
}

async function deployWithDeployProject(credentials: XrmFrameworkCredentials): Promise<void> {
    const deployProjectPath = input('DeployProjectPath');

    if (!deployProjectPath) {
        throw new Error(
            'The XrmFramework CLI was not found and no deploy project is configured. Add the ' +
            'XrmFramework CLI installer task to this job, or set DeployProjectPath.');
    }

    if (credentials.federated) {
        tl.warning(
            'The deploy project executable cannot use workload identity federation - only the ' +
            'XrmFramework CLI can. It will read Config/connectionStrings.config instead. Add the ' +
            'XrmFramework CLI installer task to this job to deploy without a secret.');
    }

    const executable = findDeployExecutable(deployProjectPath);

    console.log(`Deploying with ${executable}`);

    const exitCode = await tl.tool(executable).arg('-NoPrompt').exec({ ignoreReturnCode: true } as never);

    if (exitCode !== 0) {
        throw new Error(`${path.basename(executable)} exited with code ${exitCode}.`);
    }
}

/**
 * How the CLI should authenticate, from what the service connection turned out to carry.
 *
 * A secret is handed over directly rather than written into a `connectionStrings.config` first - and
 * through the environment, never the command line.
 */
function authMode(credentials: XrmFrameworkCredentials): string {
    if (credentials.federated) return 'wif';

    if (credentials.clientSecret) {
        tl.warning(
            `The ${credentials.scheme} service connection carries an application secret. It works, ` +
            'but a secret has to be stored and rotated and can leak: converting the connection to ' +
            'Workload Identity federation removes it entirely.');

        return 'clientsecret';
    }

    tl.warning(
        `The ${credentials.scheme} service connection carries neither a federated identity nor an ` +
        'application secret, so the deployment falls back to Config/connectionStrings.config. Run ' +
        'the XrmFramework connectionStrings creation task before this one.');

    return 'connectionstring';
}

/** The CLI, installed by the installer task or already on the agent. */
function findCli(): string | undefined {
    const onPath = tl.which('xrmframework', false);

    if (onPath) return onPath;

    const fromVariable = tl.getVariable('XrmFrameworkCliPath');

    return fromVariable && tl.exist(fromVariable) ? fromVariable : undefined;
}

/**
 * The built plugin assembly, when the task was given only the project folder.
 *
 * Looks under the build output for an assembly named after the project, the way this task has
 * always found the deploy executable, so a pipeline that only ever set PluginProjectPath can move
 * to the CLI without new inputs.
 */
function discoverAssembly(): string {
    const projectPath = pluginProjectPath();

    if (!projectPath) {
        throw new Error(
            'Set DllPath, or PluginProjectPath - or Project, for a project in a folder of that ' +
            'name under the project root - so the assembly can be found under its build output.');
    }

    if (!tl.exist(projectPath)) {
        throw new Error(
            `No plugin project folder at '${projectPath}'. Set PluginProjectPath, or DllPath for ` +
            'an assembly built somewhere else entirely.');
    }

    const name = lastSegment(projectPath);
    const root = path.join(projectPath, 'bin', configuration());

    // The reference assembly the SDK writes next to the real one - bin/<configuration>/<tfm>/ref -
    // carries no IL, so it is never the one to deploy.
    const matches = tl.findMatch(root, [`**/${name}.dll`, `!**/ref/${name}.dll`]);

    if (matches.length === 0) {
        throw new Error(`No assembly named '${name}.dll' found under '${root}'. Set DllPath explicitly.`);
    }

    return matches[0];
}

function deriveProjectName(): string {
    const projectPath = input('PluginProjectPath');

    if (!projectPath) {
        throw new Error('Set Project, the project name as declared under <projects> in xrmFramework.config.');
    }

    return lastSegment(projectPath);
}

/**
 * The plugin project's folder, which the assembly is found under.
 *
 * A project almost always lives in a folder named after it, next to the `Config` folder, so the
 * project name alone is enough: `Project` on its own stands for `<project root>/<Project>`, the
 * mirror image of a `PluginProjectPath` on its own standing for the project name. Setting both
 * covers the layout where the two differ.
 */
function pluginProjectPath(): string | undefined {
    const explicit = input('PluginProjectPath');

    if (explicit) return explicit;

    const project = input('Project');

    return project ? path.join(projectRoot(), project) : undefined;
}

/** The folder holding `Config/xrmFramework.config`, which every path here is relative to. */
function projectRoot(): string {
    return tl.getPathInput('ProjectRoot', true, true);
}

/**
 * The deploy project's executable.
 *
 * Several may be produced side by side - `Plugins.exe` and `Deploy.Plugins.exe` - so only the one
 * named after the project is kept, as the PowerShell this replaces did.
 */
function findDeployExecutable(deployProjectPath: string): string {
    const name = lastSegment(deployProjectPath);
    const root = path.join(deployProjectPath, 'bin', configuration());

    const matches = tl.findMatch(root, ['**/*.exe'])
        .filter(match => path.basename(match, '.exe').toLowerCase() === name.toLowerCase());

    if (matches.length === 0) {
        throw new Error(`No executable named '${name}.exe' found under '${root}'`);
    }

    return matches[0];
}

/** The build configuration the assembly was built under. */
function configuration(): string {
    return input('Configuration') || 'Release';
}

/** Last non-empty segment of a path, whichever separator it uses. */
function lastSegment(value: string): string {
    const segments = value.split(/[\\/]/).filter(segment => segment.length > 0);

    return segments[segments.length - 1];
}

void run();
