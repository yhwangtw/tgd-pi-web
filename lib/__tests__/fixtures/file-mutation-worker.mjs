import { withFileMutationLock } from "../../file-mutation-lock.ts";

const [directory, target] = process.argv.slice(2);
try {
  await withFileMutationLock(directory, target, async () => {
    process.send({ type: "locked" });
    await new Promise(resolve => process.once("message", resolve));
  });
  process.send({ type: "released" });
} catch (error) {
  process.send({ type: "error", message: error.message, status: error.status });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
