import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateTag } from "./release-policy.mjs";

export function shouldBeLatest(tag, releases, now = new Date()) {
  const tuple = (value) => {
    const valid = validateTag(value, { now, existing: true });
    const [date, sequence = "0"] = valid.split("-");
    return [date, Number(sequence)];
  };
  const [date, sequence] = tuple(tag);
  return releases.filter((release) => !release.draft && !release.prerelease).every((release) => {
    // This repository used v0.x.y before moving to calendar releases.
    if (/^v0\.\d+\.\d+$/.test(release.tag_name)) return true;
    // Unknown version schemes require operator review, not a silent latest change.
    const [otherDate, otherSequence] = tuple(release.tag_name);
    return date > otherDate || (date === otherDate && sequence >= otherSequence);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pages = JSON.parse(readFileSync(process.argv[3], "utf8"));
    console.log(shouldBeLatest(process.argv[2], pages.flat()));
  } catch (error) {
    console.error(`Release stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
