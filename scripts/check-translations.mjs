import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const stringsPath = path.join(rootDir, 'src', 'strings.ts');
const locales = ['es', 'fr', 'de', 'ja'];
const strict = process.argv.includes('--strict');

const source = await fs.readFile(stringsPath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    removeComments: true
  }
}).outputText;
const catalog = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`);

console.log('Translation fallback audit');
let fallbackCount = 0;
for (const locale of locales) {
  const report = catalog.getTranslationAudit(locale);
  fallbackCount += report.fallbackKeys.length;
  console.log(`\n${locale}: ${report.translatedKeys}/${report.totalKeys} translated; ${report.fallbackKeys.length} English fallback key(s)`);
  for (const key of report.fallbackKeys) console.log(`  - ${key}`);
}

if (strict && fallbackCount > 0) {
  console.error(`\nTranslation audit failed: ${fallbackCount} fallback key(s) remain.`);
  process.exitCode = 1;
} else {
  console.log(`\nTranslation audit passed: ${fallbackCount} fallback key(s) reported for intentional catalog fallback.`);
}
