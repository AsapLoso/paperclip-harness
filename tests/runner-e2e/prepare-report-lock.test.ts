import { mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { prepareReportLock, refreshReportLock } from './prepare-report-lock.mjs';

it.each(['valid', 'unknown-lock', 'changed-patch', 'wrong-output'])(
  'installs only the reviewed dependency correction: %s', async variant => {
    const root = await mkdtemp(path.join(tmpdir(), 'eval-report-lock-test-'));
    const here = import.meta.dirname, relative = path.join(root, 'tests/runner-e2e');
    try {
      await mkdir(relative, { recursive: true });
      const committed = execFileSync('git', ['show', 'HEAD:pnpm-lock.yaml'], { cwd: path.resolve(here, '../..') });
      const lock = path.join(root, 'pnpm-lock.yaml');
      await writeFile(lock, committed);
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', 'pnpm-lock.yaml'], { cwd: root });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], { cwd: root });
      const corrected = Buffer.concat([committed, Buffer.from('# reviewed test correction\n')]);
      await writeFile(lock, corrected);
      const patch = execFileSync('git', ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', 'pnpm-lock.yaml'], { cwd: root });
      const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
      const policy = { inputSha256: hash(committed), outputSha256: hash(corrected), patchSha256: hash(patch) };
      await writeFile(path.join(relative, 'report-lock.json'), JSON.stringify(policy));
      await writeFile(path.join(relative, 'report-lock.patch'), patch);
      await writeFile(lock, committed);
      if (variant === 'valid') {
        expect(await prepareReportLock(root)).toBe('reviewed-correction');
        expect(createHash('sha256').update(await readFile(lock)).digest('hex')).toBe(policy.outputSha256);
        await writeFile(lock, committed);
      }
      const input = await readFile(lock);
      expect(createHash('sha256').update(input).digest('hex')).toBe(policy.inputSha256);
      await writeFile(lock, variant === 'unknown-lock' ? 'unknown\n' : input);
      if (variant === 'changed-patch') await writeFile(path.join(relative, 'report-lock.patch'), 'changed');
      if (variant === 'wrong-output') { policy.outputSha256 = '0'.repeat(64); await writeFile(path.join(relative, 'report-lock.json'), JSON.stringify(policy)); }
      if (variant === 'valid') {
        expect(await prepareReportLock(root)).toBe('reviewed-correction');
        expect(createHash('sha256').update(await readFile(lock)).digest('hex')).toBe(policy.outputSha256);
        expect(await prepareReportLock(root)).toBe('already-reviewed');
        const reviewed = parse(await readFile(lock, 'utf8'));
        const ui = JSON.parse(await readFile(path.resolve(here, '../../ui/package.json'), 'utf8'));
        for (const [name, specifier] of Object.entries(ui.dependencies)) {
          const entry = reviewed.importers.ui.dependencies[name];
          expect(entry.specifier).toBe(specifier);
          if (entry.version.startsWith('link:')) continue;
          expect(reviewed.packages, name).toHaveProperty(`${name}@${entry.version.split('(')[0]}`);
          expect(reviewed.snapshots, name).toHaveProperty(`${name}@${entry.version}`);
        }
      } else {
        await expect(prepareReportLock(root)).rejects.toThrow();
        expect(await readFile(lock)).toEqual(variant === 'unknown-lock' ? Buffer.from('unknown\n') : input);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);


it.each(['input', 'output', 'unknown'])('refreshes dependency proof only from a %s committed lock', async variant => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'eval-report-lock-refresh-')));
  const relative = path.join(root, 'tests/runner-e2e');
  const original = "lockfileVersion: '9.0'\nimporters: {}\npackages:\n  old@1.0.0: {resolution: {integrity: fixture-old}}\n";
  const resolved = "lockfileVersion: '9.0'\nimporters:\n  ui: {}\npackages:\n  added@2.0.0: {resolution: {integrity: fixture-new}}\n";
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    await mkdir(relative, { recursive: true });
    await writeFile(path.join(root, 'pnpm-lock.yaml'), original);
    const initial = { inputSha256: variant === 'input' ? hash(original) : '0'.repeat(64),
      outputSha256: variant === 'output' ? hash(original) : '1'.repeat(64), patchSha256: hash('historical') };
    await writeFile(path.join(relative, 'report-lock.json'), JSON.stringify(initial));
    await writeFile(path.join(relative, 'report-lock.patch'), 'historical');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    await writeFile(path.join(root, 'pnpm-lock.yaml'), resolved);
    if (variant === 'unknown') {
      await expect(refreshReportLock(root)).rejects.toThrow('not reviewed');
      expect(await readFile(path.join(relative, 'report-lock.patch'), 'utf8')).toBe('historical');
      expect(JSON.parse(await readFile(path.join(relative, 'report-lock.json'), 'utf8'))).toEqual(initial);
      expect(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(resolved);
      return;
    }
    if (variant === 'output') {
      const cli = path.join(relative, 'prepare-report-lock.mjs');
      await copyFile(path.join(import.meta.dirname, 'prepare-report-lock.mjs'), cli);
      expect(execFileSync(process.execPath, [cli, '--refresh'], { cwd: root, encoding: 'utf8' }).trim()).toBe('refreshed');
    } else {
      expect(await refreshReportLock(root)).toBe('refreshed');
    }
    const policy = JSON.parse(await readFile(path.join(relative, 'report-lock.json'), 'utf8'));
    const patch = await readFile(path.join(relative, 'report-lock.patch'), 'utf8');
    expect(policy).toMatchObject({ inputSha256: hash(original), outputSha256: hash(resolved), patchSha256: hash(patch) });
    await writeFile(path.join(root, 'pnpm-lock.yaml'), original);
    expect(await prepareReportLock(root)).toBe('reviewed-correction');
    expect(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(resolved);
    expect(parse(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')).packages).toEqual(parse(resolved).packages);
    expect(await prepareReportLock(root)).toBe('already-reviewed');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'refresh'], { cwd: root });
    expect(await refreshReportLock(root)).toBe('unchanged');
    expect(await readFile(path.join(relative, 'report-lock.patch'), 'utf8')).toBe(patch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refreshes the report proof from the trusted pre-merge lock after a clean upstream lock update', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'eval-report-lock-upstream-')));
  const relative = path.join(root, 'tests/runner-e2e');
  const original = "lockfileVersion: '9.0'\nimporters: {}\npackages:\n  old@1.0.0: {resolution: {integrity: fixture-old}}\n";
  const upstream = "lockfileVersion: '9.0'\nimporters: {}\npackages:\n  upstream@2.0.0: {resolution: {integrity: fixture-upstream}}\n";
  const resolved = "lockfileVersion: '9.0'\nimporters:\n  ui: {}\npackages:\n  upstream@2.0.0: {resolution: {integrity: fixture-upstream}}\n  resolved@3.0.0: {resolution: {integrity: fixture-resolved}}\n";
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  try {
    await mkdir(relative, { recursive: true });
    await writeFile(path.join(root, 'pnpm-lock.yaml'), original);
    const policy = { inputSha256: hash(original), outputSha256: hash(original), patchSha256: hash('historical') };
    await writeFile(path.join(relative, 'report-lock.json'), JSON.stringify(policy));
    await writeFile(path.join(relative, 'report-lock.patch'), 'historical');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fork baseline'], { cwd: root });
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    // A clean upstream merge committed its changed lockfile before refresh.
    await writeFile(path.join(root, 'pnpm-lock.yaml'), upstream);
    execFileSync('git', ['add', 'pnpm-lock.yaml'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'upstream lock update'], { cwd: root });
    await writeFile(path.join(root, 'pnpm-lock.yaml'), resolved);

    expect(await refreshReportLock(root, baseline)).toBe('refreshed');
    const refreshed = JSON.parse(await readFile(path.join(relative, 'report-lock.json'), 'utf8'));
    const patch = await readFile(path.join(relative, 'report-lock.patch'));
    expect(refreshed).toMatchObject({ inputSha256: hash(original), outputSha256: hash(resolved), patchSha256: hash(patch) });
    expect(execFileSync('git', ['apply', '--numstat', '-'], { cwd: root, input: patch, encoding: 'utf8' })).toMatch(/^\d+\s+\d+\s+pnpm-lock\.yaml\n$/);
    await expect(refreshReportLock(root)).rejects.toThrow('not reviewed');

    // The generated proof applies cleanly when starting from the trusted fork lock.
    await writeFile(path.join(root, 'pnpm-lock.yaml'), original);
    expect(await prepareReportLock(root)).toBe('reviewed-correction');
    expect(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(resolved);
  } finally { await rm(root, { recursive: true, force: true }); }
});
