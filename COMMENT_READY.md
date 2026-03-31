I've been playing with v2 → v3 migrations and noticed a lot of repos "migrate" but still break in practice.

Built a small validator to check if a repo is actually V3-ready (plugins, ESM/CJS, ethers versions, config issues, etc.):

https://github.com/ivan09069/hardhat-v3-migration-validator

Might be useful as a follow-up step after the migration runs.
