import fs from 'node:fs';

function main() {
  const envPath = process.argv[2] ?? '.env';

  if (!fs.existsSync(envPath)) {
    console.error(`[check_env] Missing ${envPath}`);
    process.exit(2);
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const findLine = (key) => lines.find((l) => l.startsWith(`${key}=`));

  const apiKeyLine = findLine('OPENAI_API_KEY');
  const modelLine = findLine('OPENAI_MODEL');
  const baseLine = findLine('OPENAI_BASE_URL');

  const apiKeyVal = apiKeyLine ? apiKeyLine.slice('OPENAI_API_KEY='.length) : '';
  const modelVal = modelLine ? modelLine.slice('OPENAI_MODEL='.length) : '';
  const baseVal = baseLine ? baseLine.slice('OPENAI_BASE_URL='.length) : '';

  const marker = 'OPENAI_API_KEY=';
  const idx = raw.indexOf(marker);
  const nextChar = idx >= 0 ? raw[idx + marker.length] : null;

  const report = {
    envPath,
    hasKeyLine: Boolean(apiKeyLine),
    keyLen: (apiKeyVal || '').trim().length,
    keyLooksLikeSk: (apiKeyVal || '').trim().startsWith('sk-'),
    nextCharAfterEqualsIsNewline: nextChar === '\r' || nextChar === '\n',
    modelSet: Boolean(modelVal.trim()),
    baseUrlSet: Boolean(baseVal.trim()),
  };

  console.log(JSON.stringify(report, null, 2));

  if (!report.keyLen) {
    console.error('[check_env] OPENAI_API_KEY is empty. Paste your key on the same line as OPENAI_API_KEY=... then save the file.');
    process.exit(1);
  }

  process.exit(0);
}

main();
