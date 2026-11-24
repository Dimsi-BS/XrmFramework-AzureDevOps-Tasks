// Copyright (c) Dimsi. Licensed under the MIT License.

// Publishes a .vsix to the Visual Studio Marketplace through Trusted Publishing: no PAT, the
// GitHub Actions job's own identity.
//
//   node scripts/publish-marketplace.js <path to .vsix>
//
// Runs only in a GitHub Actions job with `permissions: id-token: write`, from the repository and
// workflow that the publisher's Trusted Publishing policy names.
//
// tfx-cli has no OIDC option of its own, so the exchange is done here, the way vsce does it for
// `vsce publish --oidc`: a GitHub OIDC token for the Marketplace audience is traded for a
// short-lived Marketplace credential. That credential is used exactly like a PAT - vsce and tfx
// both send it as basic authentication with the user name "OAuth" - so tfx publishes with it
// unchanged.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MARKETPLACE_URL = 'https://marketplace.visualstudio.com';
const AUDIENCE = 'marketplace.visualstudio.com';

async function main() {
    const vsix = process.argv[2];

    if (!vsix || !fs.existsSync(vsix)) {
        throw new Error(`No .vsix at "${vsix || ''}". Usage: node scripts/publish-marketplace.js <path to .vsix>`);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vss-extension.json'), 'utf8'));
    const credential = await marketplaceCredential(manifest.publisher);

    // Masked before anything can print it. It expires after 15 minutes regardless.
    console.log(`::add-mask::${credential}`);

    console.log(`Publishing ${path.basename(vsix)} as ${manifest.publisher}.${manifest.id} ${manifest.version}`);

    execFileSync(process.execPath, [
        require.resolve('tfx-cli/_build/tfx-cli.js'),
        'extension', 'publish',
        '--vsix', vsix,
        '--auth-type', 'pat',
        '--token', credential,
        '--no-prompt',
    ], { stdio: 'inherit' });
}

async function marketplaceCredential(publisherName) {
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    if (!requestUrl || !requestToken) {
        throw new Error('No GitHub Actions OIDC token available: run in a GitHub Actions job with `permissions: id-token: write`.');
    }

    const tokenUrl = new URL(requestUrl);
    tokenUrl.searchParams.set('audience', AUDIENCE);

    const oidc = await requestJson('GitHub Actions OIDC token request', tokenUrl, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
    });

    if (typeof oidc.value !== 'string' || !oidc.value) {
        throw new Error('GitHub Actions returned no OIDC token.');
    }

    const exchange = await requestJson('Marketplace OIDC token exchange', `${MARKETPLACE_URL}/_apis/gallery/token?api-version=7.2-preview.1`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            Authorization: `FederatedToken ${oidc.value}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publisherName }),
    });

    if (typeof exchange.credential !== 'string' || !exchange.credential) {
        throw new Error('The Marketplace returned no credential.');
    }

    return exchange.credential;
}

async function requestJson(what, url, init) {
    const response = await fetch(url, init);

    if (!response.ok) {
        // The body explains a refused exchange - typically a policy that does not name this
        // repository, workflow or environment - and holds no secret.
        throw new Error(`${what} failed: ${response.status} ${response.statusText} ${await response.text()}`);
    }

    return response.json();
}

main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
});
