const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig');

const originalWarn = console.warn;
console.warn = (...args) => {
    originalWarn(...args);
    throw new Error(`console.warn treated as error: ${args.join(' ')}`);
};

module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/src/'],
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: {
                    baseUrl: '.',
                    target: 'es6',
                    isolatedModules: true,
                },
            },
        ],
    },
    testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
    moduleNameMapper: {
        ...pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>' }),
        '^package.json$': '<rootDir>/package.json',
    },
};
