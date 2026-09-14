# hardhat-v3-migration-validator

Post-migration correctness validator for Hardhat V2 → V3 migrations.

Answers: **"Is this repo actually V3-ready?"** — not "did someone attempt a migration."

Single-file, zero-dependency Node.js CLI. Runs in any Hardhat project with one command.

## Why

Migration skills handle transforms. This handles **correctness**. It catches the things that survive a migration attempt but still break at runtime: mixed dependency surfaces, CJS/ESM mismatches, unregistered plugins, legacy config shapes, stale ethers v5 patterns, and incomplete plugin ecosystem upgrades.

Designed to complement Nomic Foundation's migration skill effort ([#8016](https://github.com/NomicFoundation/hardhat/issues/8016)).

## What it checks

1. **Dependencies** — Hardhat version, legacy packages, mixed toolbox stacks, ethers v5 remnants
2. **Module system** — CJS vs ESM mismatch, package.json type, config syntax coherence
3. **Config shape** — defineConfig usage, declarative plugins, network types, legacy etherscan, secrets handling, task/hook patterns
4. **Plugin ecosystem** — hardhat-deploy, OZ upgrades, gas-reporter, coverage, verify, docgen, typechain, waffle
5. **Source/tests** — ethers v5 API patterns, hardhat-deploy v1 conventions, ambient hre assumptions, stale scripts
6. **Execution (opt-in)** — Node version, installed Hardhat binary, config load test

## Usage

```bash
# Scan current directory without executing its code
node validate-hardhat-v3.mjs --project .

# Scan a specific project
node validate-hardhat-v3.mjs --project /path/to/hardhat-repo

# Run installed Hardhat only after trusting the target project's code
node validate-hardhat-v3.mjs --project /path/to/hardhat-repo --exec

# Include LOW and INFO severity findings
node validate-hardhat-v3.mjs --include-low
```

Or run the source file directly without publishing:

```bash
node validate-hardhat-v3.mjs --project .
```

## Example findings

- **BLOCKER:** No Hardhat config detected at repo root
- **HIGH:** Hardhat v2 still installed
- **MEDIUM:** ESM/CJS mismatch in config and package mode

## Output

Console output is the default. Opt in to either report with `--json` or
`--markdown`, using `--output-dir /path/to/review-output` to select its destination
(default: current working directory). Existing files are never overwritten:

- `hardhat-v3-validator-report.json` — machine-readable, stable schema
- `hardhat-v3-validator-report.md` — human-readable with remediation guidance

Exit codes: `0` = PASS, `1` = HIGH findings, `2` = BLOCKER findings.

## Flags

| Flag | Description |
|------|-------------|
| `--project <path>` | Target repo (default: current directory) |
| `--json` | Write JSON report |
| `--markdown` | Write Markdown report |
| `--output-dir <path>` | Report destination (default: current working directory) |
| `--exec` | Execute the target's installed Hardhat CLI |
| `--no-exec` | Skip execution checks (default; overrides `--exec`) |
| `--include-low` | Include LOW and INFO findings |

## Severity Model

| Level | Meaning |
|-------|---------|
| BLOCKER | Migration cannot succeed without fixing this |
| HIGH | Likely to cause runtime failures |
| MEDIUM | Potential issues requiring review |
| LOW | Minor concerns or style issues |
| INFO | Informational, no action needed |

## Sample Output

```
════════════════════════════════════════════════════════════
  hardhat-v3-migration-validator
  2026-03-31T18:20:33.282Z
════════════════════════════════════════════════════════════
  Project:  /path/to/remix-project
  Status:   ❌ FAIL
════════════════════════════════════════════════════════════
  BLOCKER: 2  HIGH: 1  MEDIUM: 0  LOW: 1  INFO: 1
════════════════════════════════════════════════════════════

  Top findings:
    🔴 HHV-001 [BLOCKER] Hardhat V2 still installed
    🔴 HHV-004 [BLOCKER] No hardhat config file found
    🟠 HHV-003 [HIGH] package.json missing "type": "module"
```

See `sample-output/` for full report examples.

## Requirements

- Node.js 22.13+ on a supported even-numbered major release (no CLI dependencies)

## Design

- Static checks read files without executing project code
- Reports are explicit; runtime checks execute trusted target code and may have side effects
- Static findings are heuristics, with runtime results dependent on the local environment
- High signal: every finding has severity, evidence, why, and fix

## License

MIT

## Safe review defaults

The CLI now performs static checks by default: it does not execute target code,
install packages, or write reports. `--no-exec` remains supported and takes priority
if both execution flags are supplied. Runtime checks require explicit `--exec`
and use only the installed Hardhat CLI, without invoking npx or a shell.

Reports require `--json` and/or `--markdown`. Set `--output-dir` to a separate
review directory. Existing reports are never overwritten, and there is no fallback
write into the source directory. A static PASS is a heuristic result, not a compile,
test, deployment, or security certification.

```sh
node validate-hardhat-v3.mjs --project . --no-exec
node --test
```
