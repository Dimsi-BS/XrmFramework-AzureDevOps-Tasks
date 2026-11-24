// Copyright (c) Dimsi. Licensed under the MIT License.

import tl = require('azure-pipelines-task-lib/task');
import { XrmFrameworkCredentials, azureDevOpsOidcRequest, inheritedEnvironment, resolveCredentials } from '../Shared/xrmframework-credentials';

/**
 * Puts a Power Platform environment into, or out of, administration mode.
 *
 * The work is delegated to `pac admin set-runtime-state`, which is the supported surface for it:
 * the only alternative is the environment-update REST call that the
 * `Microsoft.PowerApps.Administration.PowerShell` module wraps, and which Microsoft does not
 * document. The module this task used to install at runtime is replaced by a tool a Power Platform
 * pipeline already has - one external dependency for another, with no PowerShell and a command that
 * takes the environment URL directly, so the URL no longer has to be resolved to an id first.
 */
async function run(): Promise<void> {
    try {
        const authenticationType = tl.getInput('authenticationType', true);
        const credentials = await resolveCredentials(authenticationType);

        const environmentUrl = tl.getInput('Environment', false) || credentials.environmentUrl;

        if (!environmentUrl) {
            throw new Error('No environment URL: set it on the task, or on the service connection.');
        }

        const pac = findPac();
        const environment = credentialEnvironment(credentials);

        // A profile of its own, named after the job, so the agent's existing pac profiles are left
        // alone and two jobs on the same agent cannot fight over the active one.
        const profile = `xrmframework-${tl.getVariable('System.JobId') || Date.now()}`.substring(0, 30);

        await createProfile(pac, profile, credentials, environmentUrl, environment);

        try {
            await setRuntimeState(pac, environmentUrl, environment);
        } finally {
            await deleteProfile(pac, profile, environment);
        }
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err instanceof Error ? err.message : String(err));
    }
}

async function createProfile(
    pac: string,
    profile: string,
    credentials: XrmFrameworkCredentials,
    environmentUrl: string,
    environment: { [key: string]: string }): Promise<void> {
    const runner = tl.tool(pac)
        .arg(['auth', 'create'])
        .arg(['--name', profile])
        .arg(['--environment', environmentUrl]);

    if (credentials.federated) {
        requireBoth(credentials, 'a federated connection');

        runner.arg('--azureDevOpsFederated')
            .arg(['--tenant', credentials.tenantId])
            .arg(['--applicationId', credentials.clientId]);
    } else if (credentials.clientSecret) {
        requireBoth(credentials, 'an application secret');

        runner.arg(['--tenant', credentials.tenantId])
            .arg(['--applicationId', credentials.clientId])
            .arg(['--clientSecret', credentials.clientSecret]);
    } else if (credentials.username) {
        runner.arg(['--username', credentials.username])
            .arg(['--password', credentials.password || '']);
    } else {
        throw new Error(
            `The ${credentials.scheme} service connection carries no credentials this task can use.`);
    }

    const exitCode = await runner.exec({ env: environment, ignoreReturnCode: true } as never);

    if (exitCode !== 0) {
        throw new Error(`pac auth create exited with code ${exitCode}.`);
    }
}

async function setRuntimeState(
    pac: string,
    environmentUrl: string,
    environment: { [key: string]: string }): Promise<void> {
    const runner = tl.tool(pac)
        .arg(['admin', 'set-runtime-state'])
        .arg(['--environment', environmentUrl])
        .arg(['--runtime-state', tl.getInput('runtimeState', true)]);

    const backgroundOperations = tl.getInput('BackgroundOperations', false);

    if (backgroundOperations) runner.arg(['--background-operations', backgroundOperations]);

    const exitCode = await runner.exec({ env: environment, ignoreReturnCode: true } as never);

    if (exitCode !== 0) {
        throw new Error(`pac admin set-runtime-state exited with code ${exitCode}.`);
    }
}

/** Best effort: a profile left behind is untidy, not a reason to fail a state change that worked. */
async function deleteProfile(
    pac: string,
    profile: string,
    environment: { [key: string]: string }): Promise<void> {
    try {
        await tl.tool(pac).arg(['auth', 'delete']).arg(['--name', profile])
            .exec({ env: environment, ignoreReturnCode: true, silent: true } as never);
    } catch {
        tl.debug(`The pac profile ${profile} could not be deleted.`);
    }
}

function requireBoth(credentials: XrmFrameworkCredentials, description: string): void {
    const missing: string[] = [];

    if (!credentials.tenantId) missing.push('a tenant id');
    if (!credentials.clientId) missing.push('an application id');

    if (missing.length > 0) {
        throw new Error(`The service connection is ${description} without ${missing.join(' and ')}.`);
    }
}

function findPac(): string {
    const pac = tl.which('pac', false);

    if (pac) return pac;

    throw new Error(
        'The Power Platform CLI (pac) was not found on PATH. Add the Power Platform Tool Installer ' +
        'task to this job, or install it with "dotnet tool install --global Microsoft.PowerApps.CLI.Tool".');
}

/**
 * What pac needs in its environment: for a federated connection, the OIDC request it will make
 * itself. Never a secret - those travel as arguments pac masks, or not at all.
 */
function credentialEnvironment(credentials: XrmFrameworkCredentials): { [key: string]: string } {
    if (!credentials.federated) return inheritedEnvironment({});

    const endpointId = tl.getInput(tl.getInput('authenticationType', true), true);
    const request = azureDevOpsOidcRequest(endpointId);

    return inheritedEnvironment({
        PAC_ADO_ID_TOKEN_REQUEST_URL: request.url,
        PAC_ADO_ID_TOKEN_REQUEST_TOKEN: request.token,
    });
}

void run();
