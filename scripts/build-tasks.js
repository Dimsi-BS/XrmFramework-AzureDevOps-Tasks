// Copyright (c) Dimsi. Licensed under the MIT License.

// Builds every task under Tasks/: type-checks it against its own tsconfig, then bundles its
// index.ts into the index.js its task.json runs.
//
// Bundling is what lets Tasks/Shared exist only once: its code is inlined into each task that
// imports it. npm packages stay external and are loaded from the task's own node_modules, which
// ships with it - azure-pipelines-task-lib reads its resource files from there at run time.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const tasksRoot = path.join(__dirname, '..', 'Tasks');
const tsc = require.resolve('typescript/bin/tsc');

const tasks = fs.readdirSync(tasksRoot)
    .filter((name) => fs.existsSync(path.join(tasksRoot, name, 'task.json')));

for (const task of tasks) {
    const taskDir = path.join(tasksRoot, task);
    const manifest = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
    const targets = new Set(Object.values(manifest.execution || {}).map((handler) => handler.target));

    console.log(`> ${task}`);

    execFileSync(process.execPath, [tsc, '-p', taskDir], { stdio: 'inherit' });

    for (const target of targets) {
        const entry = path.join(taskDir, target.replace(/\.js$/, '.ts'));

        esbuild.buildSync({
            entryPoints: [entry],
            outfile: path.join(taskDir, target),
            bundle: true,
            packages: 'external',
            // The tsconfig maps azure-pipelines-task-lib to a path for type-checking ../Shared; left to
            // itself esbuild would follow that mapping and inline the library.
            tsconfigRaw: {},
            external: ['azure-pipelines-task-lib', 'azure-pipelines-task-lib/*'],
            platform: 'node',
            target: 'node20',
            format: 'cjs',
            logLevel: 'warning',
        });
    }
}
