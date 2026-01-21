const esbuild = require('esbuild');
const JavaScriptObfuscator = require('javascript-obfuscator');

const fs = require('fs');
const path = require('path');

const ENTRY_POINT = path.join(__dirname, '../src/index.ts');
const OUT_DIR = path.join(__dirname, '../dist');
const OUT_FILE = path.join(OUT_DIR, 'worker.js');

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
            // === 基础压缩 ===
            compact: true,
            simplify: true, // 开启简化，有助于减小体积
            target: 'browser-no-eval', // Worker 不支持 eval，使用这个更安全

            // === 关键：保护 Worker 的稳定性 ===
            renameGlobals: false, // 【必须修改】防止 fetch 等全局变量失效
            ignoreImports: true,  // 【必须修改】防止 cloudflare:sockets 等导入失效
            renameProperties: false, // 保持属性名，防止 API 调用失败

            // === 标识符混淆 (变量名) ===
            identifierNamesGenerator: 'hexadecimal', // 使用 16 进制命名 (_0x...) 比 mangled 更难读
            identifiersPrefix: '',
            renamePropertiesMode: 'safe',

            // === 字符串加密 (适度) ===
            stringArray: true,
            stringArrayEncoding: ['base64'], // RC4 更强但更慢，Base64 是均衡选择
            stringArrayThreshold: 0.75,      // 【修改】降到 0.75，保留部分高频字符串不加密，提升性能
            stringArrayRotate: true,
            stringArrayShuffle: true,
            stringArrayWrappersCount: 2,
            stringArrayWrappersChainedCalls: true, // 【修改】开启链式调用，增加分析难度

            // === 移除过于激进的设置 ===
            splitStrings: false,          // 【修改】关闭字符串拆分，减小体积
            unicodeEscapeSequence: false, // 【修改】关闭 Unicode 转义，减小体积

            // === 性能保护 (全部关闭) ===
            controlFlowFlattening: false,
            deadCodeInjection: false,
            numbersToExpressions: false,
            selfDefending: false,
            debugProtection: false,
            disableConsoleOutput: true,
            transformObjectKeys: false,
        }).getObfuscatedCode();

    // 5. 将混淆后的代码写回文件
    fs.writeFileSync(OUT_FILE, obfuscatedCode, 'utf-8');

    console.log('构建完成，输出文件：', OUT_FILE);
}
build().catch((error) => {
    console.error('构建失败：', error);
    process.exit(1);
});