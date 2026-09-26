import { describe, expect, it } from 'vitest';
import { changedFiles, classifyChanges, matrices } from '../ci-scope.mjs';

describe('proportional CI coverage', () => {
  it('selects docs only for an exclusively documented change', () => {
    expect(classifyChanges(['AGENTS.md', 'README.zh-TW.md', 'docs/RELEASING.md'])).toBe('docs');
    expect(classifyChanges(['docs/example.sh'])).toBe('normal');
    expect(classifyChanges(['docs/example.md', 'lib/session-reader.ts'])).toBe('normal');
  });
  it('uses representative runtimes normally and every supported boundary for compatibility changes', () => {
    expect(matrices('normal').runtime.include).toHaveLength(2);
    const full = matrices('compatibility');
    expect(full.runtime.include).toHaveLength(8);
    expect(full.install).toEqual(['ubuntu-latest', 'macos-latest']);
    for (const file of ['package-lock.json', 'setup.sh', 'scripts/check-node-version.mjs', '.github/workflows/ci.yml']) expect(classifyChanges([file])).toBe('compatibility');
  });
  it('runs full checks for manual requests, unknown history and empty diffs', () => {
    expect(classifyChanges(['README.md'], { manual: true })).toBe('compatibility');
    expect(classifyChanges(['README.md'], { unknown: true })).toBe('compatibility');
    expect(classifyChanges([])).toBe('compatibility');
  });
  it('compares PRs from their merge base and includes deleted paths in rename classification', () => {
    const head = 'a'.repeat(40), base = 'b'.repeat(40);
    const result = changedFiles({ pull_request: { head: { sha: head }, base: { sha: base } } }, 'pull_request', args => {
      expect(args).toEqual(['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`]);
      return 'lib/example.ts\0docs/example.md\0';
    });
    expect(classifyChanges(result.files)).toBe('normal');
    expect(() => changedFiles({ after: head, before: '0'.repeat(40) }, 'push')).toThrow('Missing base');
  });
});
