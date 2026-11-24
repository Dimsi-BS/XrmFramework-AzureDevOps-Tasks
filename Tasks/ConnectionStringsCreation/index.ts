// Copyright (c) Dimsi. Licensed under the MIT License.

import tl = require('azure-pipelines-task-lib/task');
import fs = require('fs');
import path = require('path');
import { XrmFrameworkCredentials, resolveCredentials } from '../Shared/xrmframework-credentials';
import { escapeAttribute, readSelectedConnection } from './xrmframework-config';

/**
 * Writes a `Config/connectionStrings.config` holding the credentials of a service connection, under
 * the name `xrmFramework.config` selects.
 *
 * Needed only where a deployment cannot be handed its credentials directly: the scaffolded deploy
 * project executable. Both XrmFramework CLI routes - federation and application secret - supply
 * their own, so a pipeline using them needs no such file at all.
 */
async function run(): Promise<void> {
    try {
        const authenticationType = tl.getInput('authenticationType', true);
        const credentials = await resolveCredentials(authenticationType);

        const environmentUrl = tl.getInput('Environment', false) || credentials.environmentUrl;

        if (!environmentUrl) {
            throw new Error('No environment URL: set it on the task, or on the service connection.');
        }

        const configPath = tl.getPathInput('XrmFrameworkConfigPath', true, true);
        const targetPath = tl.getPathInput('ConnectionStringsConfigPath', true, false);

        const selectedConnection = readSelectedConnection(configPath);
        const connectionString = buildConnectionString(credentials, environmentUrl);

        console.log(`Writing the connection "${selectedConnection}" for ${environmentUrl} to ${targetPath}`);

        tl.mkdirP(path.dirname(targetPath));

        // The content is never logged: it holds the secret. The name and the URL above are enough
        // to tell what was written.
        fs.writeFileSync(targetPath, fileContent(selectedConnection, connectionString), 'utf8');
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err instanceof Error ? err.message : String(err));
    }
}

/**
 * The connection string for what the service connection turned out to carry.
 *
 * A federated connection has no secret to write by design, so this file cannot represent it - and
 * does not need to, since the CLI signs in with the token instead.
 */
function buildConnectionString(credentials: XrmFrameworkCredentials, environmentUrl: string): string {
    if (credentials.federated) {
        throw new Error(
            'This service connection uses Workload Identity federation, which has no secret to ' +
            'write into a connectionStrings.config. Deploy with the XrmFramework CLI instead - the ' +
            'plugin and webresource tasks sign in with the federated identity directly - or use a ' +
            'service connection carrying an application secret.');
    }

    if (credentials.clientSecret) {
        const secret = credentials.clientSecret;

        tl.setSecret(secret);

        return `AuthType=ClientSecret; Url=${environmentUrl}; AppId=${credentials.clientId}; ClientSecret=${secret};`;
    }

    if (credentials.username) {
        const password = credentials.password || '';

        tl.setSecret(password);

        // The application and redirect URI of the Microsoft-published sample client, as this task
        // has always used for a username/password connection.
        return `AuthType=OAuth; Url=${environmentUrl}; Username=${credentials.username}; ` +
            `Password=${password}; AppId=51f81489-12ee-4a9e-aaae-a2591f45987d; ` +
            'RedirectUri=app://58145B91-0C36-4500-8554-080854F2AC97;';
    }

    throw new Error(
        `The ${credentials.scheme} service connection carries neither an application secret nor a ` +
        'user name, so there are no credentials to write.');
}

function fileContent(name: string, connectionString: string): string {
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<connectionStrings>\n' +
        `  <add name="${escapeAttribute(name)}" connectionString="${escapeAttribute(connectionString)}" />\n` +
        '</connectionStrings>\n';
}

void run();
