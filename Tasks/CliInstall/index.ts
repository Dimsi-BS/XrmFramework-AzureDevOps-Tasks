// Copyright (c) Dimsi. Licensed under the MIT License.

import tl = require('azure-pipelines-task-lib/task');
import path = require('path');

/**
 * Installs the XrmFramework CLI as a .NET global tool in a folder of its own, then puts that folder
 * on PATH so the later steps of the job can simply call `xrmframework`.
 *
 * A tool path rather than `--global`: the agent's global tools folder is not reliably on PATH, and
 * a job that runs twice must not fail because the tool is already there.
 */
async function run(): Promise<void> {
    try {
        const version = optional('Version');
        const source = optional('Source');
        const toolPath = tl.getPathInput('ToolPath', true, false);

        const dotnet = tl.which('dotnet', true);

        tl.mkdirP(toolPath);

        // `update` rather than `install`: it installs when absent and changes version when present,
        // so re-running the job - or running it after a cached install - is not an error.
        const runner = tl.tool(dotnet)
            .arg(['tool', 'update', 'XrmFramework.Cli'])
            .arg(['--tool-path', toolPath]);

        // No --prerelease: a version-less install takes the latest stable, and a prerelease is
        // asked for by naming it. A pipeline should not move onto a beta because nobody set a flag.
        if (version) runner.arg(['--version', version]);

        if (source) runner.arg(['--add-source', source]);

        const exitCode = await runner.exec({ ignoreReturnCode: true } as never);

        if (exitCode !== 0) {
            tl.setResult(tl.TaskResult.Failed, `dotnet tool update exited with code ${exitCode}.`);

            return;
        }

        tl.prependPath(toolPath);
        tl.setVariable('XrmFrameworkCliPath', path.join(toolPath, 'xrmframework'));

        const installed = installedVersion(dotnet, toolPath);

        if (installed) {
            tl.setVariable('XrmFrameworkCliVersion', installed);
            console.log(`XrmFramework CLI ${installed} installed in ${toolPath}`);
        } else {
            console.log(`XrmFramework CLI installed in ${toolPath}`);
        }
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err instanceof Error ? err.message : String(err));
    }
}

/**
 * The version actually installed, read back from the tool listing rather than assumed, so the
 * output variable is true even when the input was left empty.
 *
 * Best effort: a listing that cannot be read is not worth failing an install that succeeded.
 */
function installedVersion(dotnet: string, toolPath: string): string | undefined {
    const listing = tl.execSync(dotnet, ['tool', 'list', '--tool-path', toolPath], { silent: true } as never);

    if (listing.code !== 0) return undefined;

    // "xrmframework.cli   3.2.27-beta   xrmframework" - the second column of the matching row.
    const row = listing.stdout
        .split('\n')
        .map(line => line.trim().split(/\s{2,}/))
        .find(columns => columns[0]?.toLowerCase() === 'xrmframework.cli');

    return row?.[1];
}

/** An optional input, with an empty one treated as absent rather than as an empty string. */
function optional(name: string): string | undefined {
    const value = tl.getInput(name, false);

    return value && value.trim().length > 0 ? value.trim() : undefined;
}

void run();
