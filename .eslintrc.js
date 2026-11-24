module.exports = {
    "root": true,
    "env": {
        "browser": true,
        "commonjs": true,
        "es2020": true
    },
    "extends": [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended"
    ],
    "parser": "@typescript-eslint/parser",
    "parserOptions": {
        "ecmaVersion": 11,
        // The type-aware rules below need a program. Each task has its own tsconfig, and a file
        // in Tasks/Shared is checked through the tasks that import it.
        "project": ["./Tasks/*/tsconfig.json"],
        "tsconfigRootDir": __dirname
    },
    "plugins": [
        "@typescript-eslint"
    ],
    "rules": {
        '@typescript-eslint/await-thenable': 'error', 
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        '@typescript-eslint/no-explicit-any': 'off'
    }
};
