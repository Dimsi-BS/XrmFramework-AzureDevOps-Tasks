// Copyright (c) Dimsi. Licensed under the MIT License.

// Duplicated verbatim in every task that needs it: each task folder is compiled on its own
// tsconfig with rootDir ".", so a file shared from Tasks/Common would land outside the task and
// never ship. The same reason the PowerShell helpers are copied per task in this repository.

import tl = require('azure-pipelines-task-lib/task');
import http = require('http');
import https = require('https');
import url = require('url');

/** API version of the Azure DevOps oidctoken endpoint, the one the Power Platform Build Tools request. */
const OIDC_API_VERSION = '7.2-preview.1';

export interface XrmFrameworkCredentials {
    /** Authorization scheme of the service connection, as Azure DevOps names it. */
    scheme: string;
    /** `true` when the connection federates, so no secret is involved. */
    federated: boolean;
    /** Dataverse organization URL the connection points at, or undefined. */
    environmentUrl?: string;
    tenantId?: string;
    clientId?: string;
    /** The OIDC token, already obtained. Only set when `federated`. */
    idToken?: string;
}

/**
 * Reads the service connection the task was given and, when it federates, exchanges the job's
 * identity for an OIDC token.
 *
 * This is the whole reason these tasks exist rather than a plain `script:` step: Azure DevOps makes
 * a service connection available only to a job that consumes it as a task input, so only a task can
 * read it or mint a token for it.
 */
export async function resolveCredentials(authenticationType: string): Promise<XrmFrameworkCredentials> {
    const endpointId = tl.getInput(authenticationType, true);

    const scheme = tl.getEndpointAuthorizationScheme(endpointId, true);
    const environmentUrl = tl.getEndpointUrl(endpointId, true);

    tl.debug(`Service connection ${endpointId} uses the ${scheme} scheme`);

    if (scheme !== 'WorkloadIdentityFederation') {
        // A secret-based connection: the CLI takes no connection string on its command line, so the
        // credentials have to reach it through Config/connectionStrings.config - which is what the
        // XrmFrameworkConnectionStringsCreation task writes. Nothing to inject here.
        return { scheme, federated: false, environmentUrl };
    }

    // Spelled as Azure DevOps spells them for a federated connection - lower-case, unlike the
    // secret scheme's tenantId/applicationId. getEndpointAuthorizationParameter is
    // case-insensitive, so both spellings are tried for the sake of either kind.
    const tenantId = parameter(endpointId, 'tenantid') ?? parameter(endpointId, 'tenantId');
    const clientId = parameter(endpointId, 'serviceprincipalid') ?? parameter(endpointId, 'applicationId');

    const idToken = await requestOidcToken(endpointId);

    return { scheme, federated: true, environmentUrl, tenantId, clientId, idToken };
}

/**
 * Asks Azure DevOps for an OIDC token scoped to this service connection.
 *
 * The request is the one `pac` makes, down to the headers: a POST, a lower-case `bearer` scheme and
 * `X-TFS-FedAuthRedirect: Suppress`, without which Azure DevOps may answer an HTML sign-in page
 * instead of a 401.
 */
async function requestOidcToken(serviceConnectionId: string): Promise<string> {
    const requestUrl = buildIdTokenRequestUrl(serviceConnectionId);
    const accessToken = jobAccessToken();

    tl.debug(`Requesting an OIDC token from ${requestUrl}`);

    const response = await post(requestUrl, accessToken);

    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            `Azure DevOps refused to mint an OIDC token (${response.status}) for ${requestUrl}. ` +
            `Azure DevOps said: ${errorMessage(response.body) || response.body}`);
    }

    const token = parseOidcToken(response.body);

    if (!token) {
        throw new Error(
            'Azure DevOps answered the OIDC request without an "oidcToken" field: ' + response.body);
    }

    tl.setSecret(token);

    return token;
}

interface HttpAnswer {
    status: number;
    body: string;
}

/**
 * A POST with no body, shaped exactly like pac's own request.
 *
 * `Content-Length: 0` is explicit: without it the Azure DevOps front end answers 411 to a POST that
 * carries no body, before the request ever reaches the application.
 */
function post(requestUrl: string, accessToken: string): Promise<HttpAnswer> {
    const target = url.parse(requestUrl);

    // The transport follows the URL rather than being hardcoded to TLS: Azure DevOps is always
    // https, but a test - and a self-hosted collection behind a proxy - need not be.
    const transport = target.protocol === 'http:' ? http : https;

    const options: https.RequestOptions = {
        protocol: target.protocol,
        host: target.hostname,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers: {
            Authorization: 'bearer ' + accessToken,
            Accept: 'application/json',
            'Content-Length': '0',
            'Content-Type': 'application/json',
            'X-TFS-FedAuthRedirect': 'Suppress',
        },
    };

    return new Promise<HttpAnswer>((resolve, reject) => {
        const request = transport.request(options, response => {
            let body = '';

            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode || 0, body }));
        });

        request.on('error', error => reject(
            new Error(`The Azure DevOps OIDC endpoint could not be reached (${requestUrl}): ${error.message}`)));

        request.end();
    });
}

/**
 * The oidctoken endpoint for this job, built exactly as the Power Platform Build Tools build it.
 *
 * `System.OidcRequestUri` is the same URL without its query, but it is built from the parts here so
 * the task does not depend on a variable an older agent might not publish.
 */
function buildIdTokenRequestUrl(serviceConnectionId: string): string {
    const collectionUri = tl.getVariable('System.CollectionUri') ?? tl.getVariable('System.TeamFoundationServerUri');
    const projectId = tl.getVariable('System.TeamProjectId');
    const hub = tl.getVariable('System.HostType');
    const planId = tl.getVariable('System.PlanId');
    const jobId = tl.getVariable('System.JobId');

    return `${collectionUri}${projectId}/_apis/distributedtask/hubs/${hub}/plans/${planId}/jobs/${jobId}` +
        `/oidctoken?serviceConnectionId=${encodeURIComponent(serviceConnectionId)}&api-version=${OIDC_API_VERSION}`;
}

/**
 * The job's own token.
 *
 * Taken from the `SYSTEMVSSCONNECTION` endpoint rather than `$SYSTEM_ACCESSTOKEN`, which a YAML step
 * only sees when it is mapped explicitly. Inside a task it is always there, so these tasks need no
 * `env:` block.
 */
function jobAccessToken(): string {
    const pipelineAuth = tl.getEndpointAuthorization('SYSTEMVSSCONNECTION', false);

    if (!pipelineAuth || pipelineAuth.scheme !== 'OAuth' || !pipelineAuth.parameters['AccessToken']) {
        throw new Error(
            'The pipeline connection carries no OAuth token, so no OIDC token can be requested. ' +
            'Check that the job is allowed to access the OAuth token.');
    }

    return pipelineAuth.parameters['AccessToken'];
}

function parameter(endpointId: string, name: string): string | undefined {
    const value = tl.getEndpointAuthorizationParameter(endpointId, name, true);

    return value && value.trim().length > 0 ? value.trim() : undefined;
}

function parseOidcToken(body: string): string | undefined {
    try {
        const token = JSON.parse(body)?.oidcToken;

        return typeof token === 'string' && token.length > 0 ? token : undefined;
    } catch {
        return undefined;
    }
}

/** The `message` of an Azure DevOps error envelope, which is where its diagnostics live. */
function errorMessage(body: string): string | undefined {
    try {
        const message = JSON.parse(body)?.message;

        return typeof message === 'string' ? message : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Hands the resolved credentials to the CLI through the environment, so nothing secret ever appears
 * on a command line - where it would be visible to every process on the agent.
 */
export function credentialEnvironment(credentials: XrmFrameworkCredentials): { [key: string]: string } {
    const environment: { [key: string]: string } = {};

    if (!credentials.federated) return environment;

    if (credentials.idToken) environment['XRMFRAMEWORK_OIDC_TOKEN'] = credentials.idToken;
    if (credentials.tenantId) environment['XRMFRAMEWORK_TENANT_ID'] = credentials.tenantId;
    if (credentials.clientId) environment['XRMFRAMEWORK_CLIENT_ID'] = credentials.clientId;

    return environment;
}

/**
 * The agent's environment plus the credentials, as the plain string map the tool runner wants - and
 * inherited rather than replaced, so the CLI still finds PATH, DOTNET_ROOT and the rest.
 */
export function inheritedEnvironment(extra: { [key: string]: string }): { [key: string]: string } {
    const environment: { [key: string]: string } = {};

    Object.keys(process.env).forEach(key => {
        const value = process.env[key];

        if (value !== undefined) environment[key] = value;
    });

    Object.keys(extra).forEach(key => { environment[key] = extra[key]; });

    return environment;
}
