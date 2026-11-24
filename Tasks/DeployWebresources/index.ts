// Copyright (c) Dimsi. Licensed under the MIT License.

import tl = require('azure-pipelines-task-lib/task');
import path = require('path');
import { XrmFrameworkCredentials, credentialEnvironment, inheritedEnvironment, resolveCredentials } from '../Shared/xrmframework-credentials';
import { input } from '../Shared/task-inputs';

/**
 * Publishes web resources to the environment of a service connection.
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

    const project = input('Project') || deriveProjectName();
    const webresourcesPath = input('WebresourcesProjectPath');

    console.log(`Publishing the web resources of ${project} with the XrmFramework CLI`);

    const runner = tl.tool(cli)
        .arg(['deploy', 'webresources'])
        .arg(['--project', project])
        .arg(['--project-root', tl.getPathInput('ProjectRoot', true, true)])
        .arg(['--environment', environmentUrl])
        .arg('--noprompt');

    if (webresourcesPath) runner.arg(['--path', webresourcesPath]);

    runner.arg(['--auth', authMode(credentials)]);
    runner.line(input('ExtraArguments') || '');

    const exitCode = await runner.exec({
        env: inheritedEnvironment(credentialEnvironment(credentials)),
        ignoreReturnCode: true,
    } as never);

    if (exitCode !== 0) {
        throw new Error(`xrmframework deploy webresources exited with code ${exitCode}.`);
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

    const runner = tl.tool(executable).arg('-n');

    const webresourcesPath = input('WebresourcesProjectPath');

    if (webresourcesPath) runner.arg(['-p', webresourcesPath]);

    const exitCode = await runner.exec({ ignoreReturnCode: true } as never);

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

function deriveProjectName(): string {
    const projectPath = input('WebresourcesProjectPath');

    if (!projectPath) {
        throw new Error('Set Project, the project name as declared under <projects> in xrmFramework.config.');
    }

    return lastSegment(projectPath);
}

/**
 * The deploy project's executable.
 *
 * Several may be produced side by side - `Plugins.exe` and `Deploy.Plugins.exe` - so only the one
 * named after the project is kept, as the PowerShell this replaces did.
 */
function findDeployExecutable(deployProjectPath: string): string {
    const name = lastSegment(deployProjectPath);
    const configuration = input('Configuration') || 'Release';
    const root = path.join(deployProjectPath, 'bin', configuration);

    const matches = tl.findMatch(root, ['**/*.exe'])
        .filter(match => path.basename(match, '.exe').toLowerCase() === name.toLowerCase());

    if (matches.length === 0) {
        throw new Error(`No executable named '${name}.exe' found under '${root}'`);
    }

    return matches[0];
}

/** Last non-empty segment of a path, whichever separator it uses. */
function lastSegment(value: string): string {
    const segments = value.split(/[\\/]/).filter(segment => segment.length > 0);

    return segments[segments.length - 1];
}

void run();
