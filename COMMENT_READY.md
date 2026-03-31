I noticed that dry-run migrations are already in progress and that the migration skill work (#8016, #8066) focuses on transforms — getting repos from V2 to V3.

I built a complementary tool: a **post-migration correctness validator** that checks whether a repo is actually V3-ready after transforms have been applied.

It scans dependencies, module system, config shape, the plugin ecosystem (hardhat-deploy, OZ upgrades, gas-reporter, coverage, verify, etc.), source/test patterns, and optionally runs execution checks. Outputs a PASS/WARN/FAIL report with per-finding severity, evidence, and remediation guidance.

Designed to catch the things that survive a migration attempt but still break at runtime: mixed dependency surfaces, CJS/ESM mismatches, unregistered plugins, legacy config shapes, stale ethers v5 patterns, and incomplete plugin ecosystem upgrades.

Single file, zero dependencies, runs with `node validate-hardhat-v3.mjs --project /path/to/repo`.

Repo: [REPO_URL]

Happy to adapt if this is useful as a companion to the migration skill, especially for plugin ecosystem edge cases during dry-run migrations.
