// Approved staging-only additive lineage; normal Drizzle creates real receipts.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  BASELINE_ADDITIVE_MIGRATIONS,
  digest,
  list,
  object,
  requireCondition,
  STAGING_ORIGINAL_MIGRATIONS,
} from './staging-fee-schema-policy';

function readOriginalMigrationSource(root: string) {
  const source = join(root, 'packages/db/drizzle/migrations');
  const journal = object(
    JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8'))
  );
  const entries = list(journal.entries).map(object);
  requireCondition(
    journal.version === '7' &&
      journal.dialect === 'postgresql' &&
      entries.length === 6 &&
      JSON.stringify(
        readdirSync(source)
          .filter((name) => name.endsWith('.sql'))
          .sort()
      ) ===
        JSON.stringify(
          STAGING_ORIGINAL_MIGRATIONS.map((pin) => `${pin.tag}.sql`).sort()
        ),
    'unsupported_additive_source'
  );
  return STAGING_ORIGINAL_MIGRATIONS.map((pin) => {
    const entry = entries[pin.index];
    requireCondition(
      entry?.idx === pin.index &&
        entry.version === '7' &&
        entry.tag === pin.tag &&
        typeof entry.when === 'number' &&
        Number.isSafeInteger(entry.when) &&
        String(entry.when) === pin.when &&
        entry.breakpoints === true,
      'unsupported_additive_source'
    );
    const bytes = readFileSync(join(source, `${pin.tag}.sql`));
    requireCondition(
      digest(bytes.toString('utf8')) === pin.hash,
      'unsupported_additive_source'
    );
    return {
      entry: {
        idx: pin.index,
        version: '7',
        when: entry.when,
        tag: pin.tag,
        breakpoints: true,
      },
      bytes,
      tag: pin.tag,
    };
  });
}

export function verifyOriginalMigrationSource(root: string): void {
  readOriginalMigrationSource(root);
}

// The caller owns a new private temporary directory and removes it afterward.
// Config credentials/TLS stay in the existing config/environment, never files.
export function materializeBaselineAdditiveMigrations(
  root: string,
  directory: string
): string {
  const originals = readOriginalMigrationSource(root);
  const selected = BASELINE_ADDITIVE_MIGRATIONS.map((pin) => {
    const file = originals[pin.index];
    requireCondition(file !== undefined, 'unsupported_additive_source');
    return file;
  });
  const migrations = join(directory, 'migrations');
  mkdirSync(migrations, { mode: 0o700 });
  mkdirSync(join(migrations, 'meta'), { mode: 0o700 });
  for (const file of selected) {
    writeFileSync(join(migrations, `${file.tag}.sql`), file.bytes, {
      mode: 0o600,
      flag: 'wx',
    });
  }
  writeFileSync(
    join(migrations, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: selected.map((file) => file.entry),
    }),
    { mode: 0o600, flag: 'wx' }
  );
  const config = join(directory, 'drizzle.config.cjs');
  writeFileSync(
    config,
    `const config = require(${JSON.stringify(join(root, 'packages/db/drizzle.config.cjs'))});\nmodule.exports = { ...config, out: ${JSON.stringify(relative(root, migrations))} };\n`,
    { mode: 0o600, flag: 'wx' }
  );
  return relative(root, config);
}
