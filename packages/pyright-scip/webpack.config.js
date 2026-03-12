//@ts-check

const path = require('path');
const { TsconfigPathsPlugin } = require('tsconfig-paths-webpack-plugin');
const { monorepoResourceNameMapper } = require('../../build/lib/webpack');
const CleanTerminalPlugin = require('clean-terminal-webpack-plugin');

const outPath = path.resolve(__dirname, 'dist');

/**@type {(env: any, argv: { mode: 'production' | 'development' | 'none' }) => import('webpack').Configuration}*/
module.exports = (_, { mode }) => {
    return {
        context: __dirname,
        entry: {
            'scip-python': './src/main.ts',
        },
        target: 'node',
        output: {
            filename: '[name].js',
            path: outPath,
            devtoolModuleFilenameTemplate:
                mode === 'development' ? '../[resource-path]' : monorepoResourceNameMapper('scip-python'),
            clean: true,
        },
        stats: {
            all: false,
            errors: true,
            warnings: true,
        },
        resolve: {
            extensions: ['.ts', '.js'],
            plugins: [
                new TsconfigPathsPlugin({
                    configFile: 'tsconfig.withBaseUrl.json',
                    extensions: ['.ts', '.js'],
                }),
            ],
        },
        externals: {
            fsevents: 'commonjs2 fsevents',
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    loader: 'ts-loader',
                    options: {
                        configFile: 'tsconfig.json',
                    },
                },
            ],
        },
        plugins: [
            new CleanTerminalPlugin(),
        ],
        optimization: {
            splitChunks: false,
        },
    };
};
