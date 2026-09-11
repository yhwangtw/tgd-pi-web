import { assertCheckoutStopped } from './runtime-guard.mjs';

try {
  await assertCheckoutStopped(process.argv[2] || process.cwd());
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not verify that this checkout is stopped');
  process.exitCode = 1;
}
