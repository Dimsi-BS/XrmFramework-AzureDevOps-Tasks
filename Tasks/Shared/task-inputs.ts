// Copyright (c) Dimsi. Licensed under the MIT License.

// Reading a task input, with the ways Azure DevOps hands over a value that means "nothing was set"
// filtered out. Shared, like xrmframework-credentials.ts, and bundled into each task that imports
// it by scripts/build-tasks.js.

import tl = require('azure-pipelines-task-lib/task');

/**
 * An optional input, or undefined when it was left empty.
 *
 * An input defaulting to a macro - `$(BuildTools.EnvironmentUrl)`, `$(buildConfiguration)` - keeps
 * that macro verbatim when the variable was never set: Azure DevOps leaves an unknown `$(...)` in
 * place instead of replacing it with nothing. Handed on as-is it reaches the tool as the literal
 * string `$(BuildTools.EnvironmentUrl)`, so an unexpanded macro counts as no value, which lets the
 * fallback behind it - the service connection's own URL, `Release` - apply.
 */
export function input(name: string): string | undefined {
    const value = (tl.getInput(name, false) || '').trim();

    if (value.length === 0) return undefined;

    if (/^\$\([^)]*\)$/.test(value)) {
        tl.debug(`Input ${name} is still the macro ${value}, so its variable is not set: reading it as empty.`);

        return undefined;
    }

    return value;
}

/** The same, for an input the task cannot do without. */
export function requiredInput(name: string): string {
    const value = input(name);

    if (!value) throw new Error(`The ${name} input is required.`);

    return value;
}
