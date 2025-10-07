import { promises as fs } from 'node:fs';
import path from 'node:path';

const coverageDir = 'coverage';
const reportsDir = 'reports';
const outputPath = path.join(reportsDir, 'javascript-coverage.json');

async function ensureReportsDir() {
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch (error) {
    console.error('Failed to ensure reports directory', error);
    process.exit(1);
  }
}

async function copyLatestCoverage() {
  let entries;
  try {
    entries = await fs.readdir(coverageDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('Coverage directory not found; skipping export.');
      return;
    }
    throw error;
  }

  const coverageFiles = entries.filter(name => name.endsWith('.json'));
  if (!coverageFiles.length) {
    console.warn('No coverage files generated; skipping export.');
    return;
  }

  // Sort to pick the most recent entry deterministically.
  coverageFiles.sort();
  const latest = coverageFiles[coverageFiles.length - 1];
  const source = path.join(coverageDir, latest);

  await fs.copyFile(source, outputPath);
  console.log(`Copied coverage report to ${outputPath}`);
}

await ensureReportsDir();
await copyLatestCoverage();
