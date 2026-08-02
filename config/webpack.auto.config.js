const path = require("path")
const { CleanWebpackPlugin } = require("clean-webpack-plugin")
// const JavascriptObfuscator = require("webpack-obfuscator")
const AutoProWebpackPlugin = require('@auto.pro/webpack-plugin')
const ProgressPlugin = require('progress-bar-webpack-plugin')
const Unpack = require('./devUnpack')
const ESLintWebpackPlugin = require('eslint-webpack-plugin')
const DevServer = require('./devServer')
const CopyWebpackPlugin = require('copy-webpack-plugin');
const fs = require('fs');


const dictionary = []
for (let i = 1024; i < 2048; i++) {
    dictionary.push(
        i
            .toString(2)
            .replace(/1/g, "ν")
            .replace(/0/g, "v")
    )
}

const compilePlugin = new AutoProWebpackPlugin({
    ui: ["auto"],
    // entry: {
    //     key: ''
    // }
})

const localUiRoot = process.env.ASSTTYYS_UI_DIR
    ? path.resolve(process.env.ASSTTYYS_UI_DIR)
    : path.resolve(__dirname, '../../assttyys_ui');
const localUiIndex = path.resolve(localUiRoot, 'dist/index.html');
if (!fs.existsSync(localUiIndex)) {
    throw new Error(
        `[assttyys_ui] local build output not found: ${localUiIndex}. ` +
        `Build the local UI first or set ASSTTYYS_UI_DIR to its project directory.`
    );
}
console.log(`[assttyys_ui] copy from ${localUiIndex}`);

const config = {
    entry: {
        app: path.resolve(__dirname, "../src/index.ts"),
    },
    output: {
        filename: "auto.js",
        path: path.resolve(__dirname, "../dist"),
        library: {
            name: 'MyLibrary',
            type: 'var',
        },
        // libraryTarget: "commonjs2"
    },
    target: "node",
    module: {
        rules: [
            {
                test: /\.ts$/,
                // exclude: /node_modules/,
                use: {
                    loader: "ts-loader"
                }
            },
            {
                test: /\.js$/,
                // exclude: /node_modules/,
                use: {
                    loader: "babel-loader"
                }
            },
            {
                test: /\.(png|svg|jpg|gif)$/,
                use: {
                    loader: "url-loader"
                }
            }
        ]
    },
    resolve: {
        extensions: [".js", ".ts", ".json"],
        alias: {
            "@": path.resolve(__dirname, "../src")
        }
    }
}

module.exports = (env, argv) => {
    if (argv.mode === 'development') {
        config.plugins = [
            new ESLintWebpackPlugin({
                extensions: ['ts'],
                // fix: true, // 自动修复

            }),
            new CleanWebpackPlugin({
                cleanOnceBeforeBuildPatterns: [__dirname + '/../dist/auto.js']
            }),
            compilePlugin,
            new ProgressPlugin(),
            new CopyWebpackPlugin({
                patterns: [
                    { from: localUiIndex, to: '.' },
                    // Auto.js UI XML 不是标准 JS 语法，标记后由 webpack 原样复制，跳过 Terser。
                    { from: path.resolve(__dirname, '../hotrun/main.js'), to: 'main.js', info: { minimized: true } },
                ]
            }),
            new Unpack(),
            new DevServer(),
        ]
        // config.devtool = 'source-map'
    } else {
        config.plugins = [
            new ESLintWebpackPlugin({
                extensions: ['ts'],
            }),
            new CleanWebpackPlugin({
                cleanOnceBeforeBuildPatterns: [__dirname + '/../dist/auto.js'],
            }),
            // new JavascriptObfuscator({
            //     compact: true,
            //     identifierNamesGenerator: "dictionary",
            //     identifiersDictionary: dictionary,
            //     target: "node",
            //     transformObjectKeys: false,
            //     stringArray: true,
            //     stringArrayEncoding: ['rc4'],
            // }),
            compilePlugin,
            new ProgressPlugin(),
            new CopyWebpackPlugin({
                patterns: [
                    { from: localUiIndex, to: '.' },
                    // Auto.js UI XML 不是标准 JS 语法，标记后由 webpack 原样复制，跳过 Terser。
                    { from: path.resolve(__dirname, '../hotrun/main.js'), to: 'main.js', info: { minimized: true } },
                ]
            }),
        ]
    }

    return config
}
