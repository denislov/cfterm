const esbuild = require('esbuild');
const JavaScriptObfuscator = require('javascript-obfuscator');

const fs = require('fs');
const path = require('path');

const ENTRY_POINT = path.join(__dirname, '../src/index.ts');
const OUT_DIR = path.join(__dirname, '../dist');
const OUT_FILE = path.join(OUT_DIR, '_worker.js');
const OB_OUT_FILE = path.join(OUT_DIR, 'worker.js');

async function build() {
    // 1. 确保输出目录存在
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR);
    }

    console.log('正在打包Typescript...');
    // 2. 使用 esbuild 构建项目
    await esbuild.build({
        entryPoints: [ENTRY_POINT],
        bundle: true,
        minify: false,
        sourcemap: false,
        format: 'esm',
        outfile: OUT_FILE,
        platform: 'browser',
        target: ['es2020'],
        external: ['cloudflare:sockets'],
    });

    console.log('正在混淆JavaScript代码...');
    // 3. 读取生成的文件
    const code = fs.readFileSync(OUT_FILE, 'utf-8');

    // 4. 使用 JavaScript Obfuscator 混淆代码
    const obfuscatedCode = JavaScriptObfuscator.obfuscate(code,
        {
            compact: true,
            controlFlowFlattening: false,
            controlFlowFlatteningThreshold: 0,
            deadCodeInjection: false,
            stringArray: true,
            stringArrayEncoding: ['base64'],
            stringArrayThreshold: 1.0,
            stringArrayRotate: true,
            stringArrayShuffle: true,
            stringArrayWrappersCount: 2,
            stringArrayWrappersChainedCalls: false,
            stringArrayWrappersParametersMaxCount: 3,
            renameGlobals: true,
            identifierNamesGenerator: 'mangled-shuffled',
            identifierNamesCache: null,
            identifiersPrefix: '',
            renameProperties: false,
            renamePropertiesMode: 'safe',
            ignoreImports: false,
            target: 'browser',
            numbersToExpressions: false,
            simplify: false,
            splitStrings: true,
            splitStringsChunkLength: 1,
            transformObjectKeys: false,
            unicodeEscapeSequence: true,
            selfDefending: false,
            debugProtection: false,
            debugProtectionInterval: 0,
            disableConsoleOutput: true,
            domainLock: []
        }).getObfuscatedCode();

    // 5. 将混淆后的代码写回文件
    fs.writeFileSync(OB_OUT_FILE, obfuscatedCode, 'utf-8');

    console.log('构建完成，输出文件：', OB_OUT_FILE);
}
build().catch((error) => {
    console.error('构建失败：', error);
    process.exit(1);
});