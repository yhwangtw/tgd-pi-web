# Pi Web security patch

This is `sprintf-js` 1.1.3 from https://github.com/alexei/sprintf.js, with its
BSD-3-Clause license preserved. Upstream has no published fix for
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

The local version `1.1.4-piweb.1` is **not an upstream release**. The parser rejects
widths above 10,000 and precisions above 100 before invoking formatters or
allocating padding. Normal positional/named formatting and `vsprintf` exports
remain compatible with Mammoth's argparse dependency. The production override
ensures argparse uses this implementation, including after `npm ci`.

Regression coverage: `lib/__tests__/sprintf-security.test.ts`. Replace this
local package with a verified upstream fix when one is available.
