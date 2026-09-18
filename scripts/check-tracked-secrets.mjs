import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const patterns = [
  { name: 'Google OAuth client secret', regex: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google access token', regex: /ya29\.[A-Za-z0-9_-]{30,}/ },
  { name: 'Private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'API key assignment', regex: /(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{24,}/i },
];

const findings = [];
for (const file of trackedFiles) {
  if (!fs.existsSync(file) || file === 'firebase-applet-config.json') continue;
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    if (pattern.regex.test(content)) findings.push(`${file}: ${pattern.name}`);
  }
}

if (findings.length > 0) {
  console.error('Potential secrets found in tracked files:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed (${trackedFiles.length} tracked files checked).`);
