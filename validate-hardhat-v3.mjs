#!/usr/bin/env node
/**
 * hardhat-v3-migration-validator
 * Post-migration correctness validator for Hardhat V2 → V3 migrations.
 * Single-file, zero-dependency Node.js CLI.
 *
 * Usage:
 *   node validate-hardhat-v3.mjs
 *   node validate-hardhat-v3.mjs --project /path/to/repo
 *   node validate-hardhat-v3.mjs --json --markdown --include-low
 *   node validate-hardhat-v3.mjs --no-exec
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

// ─── CLI ─────────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    project:      { type: "string",  default: "." },
    json:         { type: "boolean", default: false },
    markdown:     { type: "boolean", default: false },
    "no-exec":    { type: "boolean", default: false },
    "include-low":{ type: "boolean", default: false },
    help:         { type: "boolean", default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
hardhat-v3-migration-validator — Post-migration correctness pass

Usage:
  node validate-hardhat-v3.mjs [options]

Options:
  --project <path>   Target repo (default: current directory)
  --json             Write hardhat-v3-validator-report.json
  --markdown         Write hardhat-v3-validator-report.md
  --no-exec          Skip execution checks (install, build, config load)
  --include-low      Include LOW and INFO severity in output
  --help             Show this help
`);
  process.exit(0);
}

const ROOT = resolve(args.project);
if (!existsSync(ROOT)) { console.error(`Not found: ${ROOT}`); process.exit(1); }

// ─── SEVERITY & FINDING MODEL ────────────────────────────────────────────────
const SEV = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const SEV_LABEL = ["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"];
const SEV_ICON = ["🔴", "🟠", "🟡", "🔵", "⚪"];
let findingId = 0;
const findings = [];

function finding(severity, title, evidence, why, fix, confidence = "high") {
  findings.push({
    id: `HHV-${String(++findingId).padStart(3, "0")}`,
    severity: SEV_LABEL[severity],
    title,
    evidence,
    why,
    fix,
    confidence,
  });
}

// ─── FILE UTILITIES ──────────────────────────────────────────────────────────
function read(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}
function exists(rel) { return existsSync(join(ROOT, rel)); }
function glob(dir, exts, maxDepth = 3, depth = 0) {
  const base = join(ROOT, dir);
  if (!existsSync(base) || !statSync(base).isDirectory()) return [];
  const results = [];
  try {
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "artifacts" || e.name === "cache") continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isFile() && exts.some(x => e.name.endsWith(x))) results.push(rel);
      if (e.isDirectory() && depth < maxDepth) results.push(...glob(rel, exts, maxDepth, depth + 1));
    }
  } catch {}
  return results;
}

function searchFiles(patterns, dirs = ["test", "scripts", "deploy", "ignition", "src", "lib"]) {
  const hits = [];
  for (const d of dirs) {
    const files = glob(d, [".ts", ".js", ".mjs", ".mts"]);
    for (const f of files) {
      const content = read(f);
      if (!content) continue;
      for (const p of patterns) {
        if (p.regex.test(content)) {
          hits.push({ file: f, pattern: p.label });
        }
      }
    }
  }
  return hits;
}

function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, timeout: 30000, encoding: "utf-8", stdio: "pipe", ...opts }).trim();
  } catch (e) {
    return { error: true, stderr: (e.stderr || "").trim(), stdout: (e.stdout || "").trim(), code: e.status };
  }
}

// ─── DETECTION CONTEXT ───────────────────────────────────────────────────────
const ctx = {
  hardhatVersion: null, moduleType: null, configFile: null, configContent: null,
  packageManager: null, deps: {}, devDeps: {}, allDeps: {},
  plugins: [], testRunner: null, deployStack: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CHECK 1: PACKAGE / DEPENDENCY SURFACE
// ═══════════════════════════════════════════════════════════════════════════════
function checkPackage() {
  const raw = read("package.json");
  if (!raw) {
    finding(SEV.BLOCKER, "No package.json found", ROOT, "Cannot analyze dependencies without package.json", "Run npm init or verify project path");
    return;
  }
  const pkg = JSON.parse(raw);
  ctx.deps = pkg.dependencies || {};
  ctx.devDeps = pkg.devDependencies || {};
  ctx.allDeps = { ...ctx.deps, ...ctx.devDeps };
  ctx.moduleType = pkg.type === "module" ? "esm" : "cjs";

  // Hardhat version
  const hhVer = ctx.allDeps.hardhat || "";
  ctx.hardhatVersion = hhVer;
  if (!hhVer) {
    finding(SEV.BLOCKER, "Hardhat not found in dependencies", "package.json", "Not a Hardhat project or hardhat is missing", "npm install --save-dev hardhat");
    return;
  }
  const isV3 = /^\^?3|^3/.test(hhVer) || />=\s*3/.test(hhVer);
  const isV2 = /^\^?2|^2/.test(hhVer);
  if (isV2) {
    finding(SEV.BLOCKER, "Hardhat V2 still installed", `hardhat: "${hhVer}"`, "Migration to V3 not started or incomplete", "npm install --save-dev hardhat@^3");
  } else if (isV3) {
    finding(SEV.INFO, "Hardhat V3 detected", `hardhat: "${hhVer}"`, "Correct target version", "None");
  }

  // Legacy/deprecated packages
  const legacy = {
    "@nomiclabs/hardhat-ethers": { replace: "@nomicfoundation/hardhat-ethers@^3", sev: SEV.HIGH },
    "@nomiclabs/hardhat-waffle": { replace: "@nomicfoundation/hardhat-chai-matchers@^3", sev: SEV.HIGH },
    "@nomiclabs/hardhat-etherscan": { replace: "@nomicfoundation/hardhat-verify@^3", sev: SEV.HIGH },
    "@typechain/hardhat": { replace: "Remove — V3 has native type generation", sev: SEV.MEDIUM },
    "hardhat-gas-reporter": { replace: "Remove — V3 has built-in gas stats", sev: SEV.MEDIUM },
    "solidity-coverage": { replace: "Remove — V3 has built-in coverage", sev: SEV.MEDIUM },
    "ts-node": { replace: "Remove — V3 uses tsx/native TS support", sev: SEV.LOW },
    "@nomiclabs/hardhat-solhint": { replace: "Check V3 compatibility", sev: SEV.LOW },
  };
  for (const [pkg, info] of Object.entries(legacy)) {
    if (ctx.allDeps[pkg]) {
      finding(info.sev, `Legacy package: ${pkg}`, `${pkg}: "${ctx.allDeps[pkg]}"`, "This package is deprecated or superseded in Hardhat V3", info.replace);
    }
  }

  // Ethers version check
  const ethersVer = ctx.allDeps.ethers || "";
  if (/^\^?5|^5/.test(ethersVer)) {
    finding(SEV.HIGH, "ethers v5 still installed", `ethers: "${ethersVer}"`, "V3 ecosystem expects ethers v6 or viem", "npm install ethers@^6 or switch to @nomicfoundation/hardhat-viem");
  }

  // Detect mixed toolbox stacks
  const hasToolbox = !!ctx.allDeps["@nomicfoundation/hardhat-toolbox"];
  const hasMochaToolbox = !!ctx.allDeps["@nomicfoundation/hardhat-toolbox-mocha-ethers"];
  const hasViemToolbox = !!ctx.allDeps["@nomicfoundation/hardhat-toolbox-viem"];
  if ([hasToolbox, hasMochaToolbox, hasViemToolbox].filter(Boolean).length > 1) {
    finding(SEV.MEDIUM, "Multiple toolbox packages detected", "Conflicting toolbox stacks", "Only one toolbox should be active", "Remove duplicates, keep one toolbox");
  }

  // Package manager
  if (exists("pnpm-lock.yaml")) ctx.packageManager = "pnpm";
  else if (exists("yarn.lock")) ctx.packageManager = "yarn";
  else if (exists("bun.lockb")) ctx.packageManager = "bun";
  else if (exists("package-lock.json")) ctx.packageManager = "npm";
  else ctx.packageManager = "unknown";

  // Module type
  if (ctx.moduleType !== "esm") {
    finding(SEV.HIGH, 'package.json missing "type": "module"', `Current type: ${pkg.type || "(unset)"}`,
      "Hardhat V3 requires ESM config. Without type:module the config may not load correctly",
      'Add "type": "module" to package.json');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECK 2: MODULE SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
function checkModuleSystem() {
  // Find config file
  const configCandidates = ["hardhat.config.ts", "hardhat.config.mts", "hardhat.config.js", "hardhat.config.mjs", "hardhat.config.cjs"];
  for (const c of configCandidates) {
    if (exists(c)) { ctx.configFile = c; ctx.configContent = read(c); break; }
  }
  if (!ctx.configFile) {
    finding(SEV.BLOCKER, "No hardhat config file found", "Searched: " + configCandidates.join(", "),
      "Hardhat cannot run without a config file", "Create hardhat.config.ts with defineConfig()");
    return;
  }
  finding(SEV.INFO, "Config file found", ctx.configFile, "Config file detected", "None");
  const cfg = ctx.configContent;

  // CJS in ESM repo
  if (ctx.moduleType === "esm" && (cfg.includes("require(") || cfg.includes("module.exports"))) {
    finding(SEV.HIGH, "CJS syntax in ESM config", `${ctx.configFile} uses require() or module.exports`,
      "Package type is module but config uses CommonJS — config will fail to load",
      "Convert to import/export and export default defineConfig({...})");
  }

  // ESM in non-ESM repo
  if (ctx.moduleType !== "esm" && (cfg.includes("import ") || cfg.includes("export default"))) {
    if (!ctx.configFile.endsWith(".mts") && !ctx.configFile.endsWith(".mjs")) {
      finding(SEV.MEDIUM, "ESM syntax in CJS repo", `${ctx.configFile} uses import/export but package.json lacks type:module`,
        "Config may fail depending on Node.js resolution", 'Add "type": "module" to package.json or rename config to .mts/.mjs');
    }
  }

  // ts-node config that may break
  const tsconfig = read("tsconfig.json");
  if (tsconfig) {
    if (tsconfig.includes("ts-node") && ctx.allDeps["ts-node"]) {
      finding(SEV.LOW, "ts-node config detected", "tsconfig.json contains ts-node settings",
        "Hardhat V3 uses tsx internally — ts-node config may be ignored or cause conflicts",
        "Remove ts-node dependency and tsconfig ts-node section if not needed elsewhere");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECK 3: CONFIG SHAPE
// ═══════════════════════════════════════════════════════════════════════════════
function checkConfig() {
  if (!ctx.configContent) return;
  const cfg = ctx.configContent;

  // defineConfig usage
  if (!cfg.includes("defineConfig")) {
    finding(SEV.HIGH, "Config does not use defineConfig()", ctx.configFile,
      "Hardhat V3 expects export default defineConfig({...})",
      'import { defineConfig } from "hardhat/config" and wrap config in defineConfig()');
  }

  // Declarative plugins array
  if (cfg.includes("defineConfig") && !cfg.includes("plugins")) {
    finding(SEV.MEDIUM, "No plugins array in config", ctx.configFile,
      "V3 requires plugins to be listed in the plugins array, not just imported",
      "Add plugins: [yourPlugin, ...] to defineConfig()");
  }

  // Side-effect plugin imports (V2 pattern)
  const sideEffects = cfg.match(/^import\s+["'][^"']+["'];?\s*$/gm);
  if (sideEffects && sideEffects.length > 0) {
    finding(SEV.MEDIUM, "Side-effect plugin imports detected", sideEffects.slice(0, 3).join("; "),
      "V2-style bare imports (import 'plugin') don't register plugins in V3 — they must be in plugins[]",
      "Change to named imports and add to plugins array");
  }

  // Network config without type
  const networkBlocks = cfg.match(/(\w+)\s*:\s*\{[^}]*url\s*:/g);
  if (networkBlocks && !cfg.includes('type:') && !cfg.includes("type :")) {
    finding(SEV.HIGH, "Network configs missing type property", "Networks appear to lack type: 'http' or 'edr-simulated'",
      "V3 requires explicit network type", "Add type: 'http' for RPC networks, type: 'edr-simulated' for local");
  }

  // Legacy etherscan config
  if (cfg.includes("etherscan:") && cfg.includes("apiKey") && !cfg.includes("verify:")) {
    finding(SEV.HIGH, "Legacy etherscan config block", "etherscan: { apiKey: ... }",
      "V3 uses verify: { etherscan: { apiKey: ... } } instead of top-level etherscan",
      "Move etherscan config under verify: { etherscan: { ... } }");
  }

  // Inline secrets
  if (/process\.env\.\w+/.test(cfg)) {
    finding(SEV.MEDIUM, "process.env usage in config", "Config references process.env.*",
      "V3 recommends configVariable() from hardhat/config instead of process.env",
      'import { configVariable } from "hardhat/config" and replace process.env references');
  }

  // Custom tasks using old pattern
  if (/\btask\s*\(/.test(cfg) && !cfg.includes("setInlineAction")) {
    finding(SEV.MEDIUM, "V2-style task() definitions in config", "task() found without setInlineAction",
      "V3 task registration uses a different API with .setInlineAction().build()",
      "Migrate tasks to V3 task API — see Hardhat V3 migration guide");
  }

  // extendEnvironment / extendConfig
  if (cfg.includes("extendEnvironment") || cfg.includes("extendConfig")) {
    finding(SEV.HIGH, "V2 extensibility API detected", "extendEnvironment or extendConfig in config",
      "These APIs are removed in V3 — replaced by the hook system",
      "Migrate to hook-based extensions — this requires careful review");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECK 4: PLUGIN ECOSYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
function checkPlugins() {
  const pluginChecks = [
    { name: "hardhat-deploy", pkg: "hardhat-deploy", check: (v) => {
      if (/^\^?1|^0/.test(v)) return { status: "BLOCKED", note: "hardhat-deploy v1 is incompatible with V3. Migrate to v2/rocketh or Ignition" };
      if (/^\^?2|^2/.test(v)) return { status: "PASS", note: "hardhat-deploy v2 is V3-compatible" };
      return { status: "NEEDS_REVIEW", note: `Version ${v} — verify V3 compatibility` };
    }},
    { name: "hardhat-verify", pkg: "@nomicfoundation/hardhat-verify", check: (v) => {
      if (/^\^?3|^3/.test(v)) return { status: "PASS", note: "V3-compatible verify plugin" };
      return { status: "NEEDS_REVIEW", note: `Version ${v} — upgrade to @nomicfoundation/hardhat-verify@^3` };
    }},
    { name: "OZ Upgrades", pkg: "@openzeppelin/hardhat-upgrades", check: (v) => {
      return { status: "NEEDS_REVIEW", note: "OZ Upgrades V3 support is in pre-release. Verify hre.upgrades patterns still work. HIGH RISK migration hotspot." };
    }},
    { name: "hardhat-gas-reporter", pkg: "hardhat-gas-reporter", check: () => {
      return { status: "BLOCKED", note: "Remove — Hardhat V3 has built-in gas statistics" };
    }},
    { name: "solidity-coverage", pkg: "solidity-coverage", check: () => {
      return { status: "BLOCKED", note: "Remove — Hardhat V3 has built-in coverage" };
    }},
    { name: "hardhat-contract-sizer", pkg: "hardhat-contract-sizer", check: () => {
      return { status: "NEEDS_REVIEW", note: "Check for V3-compatible version or alternative" };
    }},
    { name: "hardhat-docgen", pkg: "hardhat-docgen", check: () => {
      return { status: "NEEDS_REVIEW", note: "Check for V3-compatible version" };
    }},
    { name: "solidity-docgen", pkg: "solidity-docgen", check: () => {
      return { status: "NEEDS_REVIEW", note: "Check for V3-compatible version" };
    }},
    { name: "hardhat-etherscan (legacy)", pkg: "@nomiclabs/hardhat-etherscan", check: () => {
      return { status: "BLOCKED", note: "Replace with @nomicfoundation/hardhat-verify@^3" };
    }},
    { name: "hardhat-waffle (legacy)", pkg: "@nomiclabs/hardhat-waffle", check: () => {
      return { status: "BLOCKED", note: "Replace with @nomicfoundation/hardhat-chai-matchers@^3" };
    }},
    { name: "typechain", pkg: "@typechain/hardhat", check: () => {
      return { status: "BLOCKED", note: "Remove — V3 generates types natively" };
    }},
  ];

  for (const pc of pluginChecks) {
    const ver = ctx.allDeps[pc.pkg];
    if (!ver) continue;
    const result = pc.check(ver);
    ctx.plugins.push({ name: pc.name, package: pc.pkg, version: ver, ...result });
    const sev = result.status === "BLOCKED" ? SEV.HIGH : result.status === "NEEDS_REVIEW" ? SEV.MEDIUM : SEV.INFO;
    finding(sev, `Plugin: ${pc.name} [${result.status}]`, `${pc.pkg}@${ver}`, result.note,
      result.status === "PASS" ? "None" : result.note);
  }

  // Detect deploy stack
  if (exists("ignition")) ctx.deployStack = "ignition";
  else if (exists("deploy")) ctx.deployStack = "hardhat-deploy";
  else if (glob("scripts", [".ts", ".js"]).some(f => f.toLowerCase().includes("deploy"))) ctx.deployStack = "scripts";
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECK 5: SOURCE / TEST SURFACE
// ═══════════════════════════════════════════════════════════════════════════════
function checkSourceTests() {
  // ethers v5 patterns in code
  const v5Patterns = [
    { regex: /ethers\.BigNumber/g, label: "ethers.BigNumber (v5 — use native BigInt in v6)" },
    { regex: /\.toNumber\(\)/g, label: ".toNumber() (v5 — use Number() or BigInt in v6)" },
    { regex: /ethers\.utils\./g, label: "ethers.utils.* (v5 — restructured in v6)" },
    { regex: /parseEther\s*\(/g, label: "parseEther (verify import path for v6)" },
    { regex: /formatEther\s*\(/g, label: "formatEther (verify import path for v6)" },
    { regex: /getContractFactory\s*\(/g, label: "getContractFactory (check ethers v6 or viem pattern)" },
    { regex: /\.deployed\(\)/g, label: ".deployed() (v5 — use .waitForDeployment() in v6)" },
    { regex: /\.address\b/g, label: ".address (v5 — use .target in v6 / await getAddress())" },
  ];
  const v5Hits = searchFiles(v5Patterns);
  if (v5Hits.length > 0) {
    const summary = [...new Set(v5Hits.map(h => h.pattern))].slice(0, 5);
    const files = [...new Set(v5Hits.map(h => h.file))].slice(0, 10);
    finding(SEV.MEDIUM, "ethers v5 API patterns detected in source", `${v5Hits.length} hits in ${files.length} files: ${summary.join("; ")}`,
      "These patterns may break or behave differently with ethers v6/viem",
      "Review and update to ethers v6 API or viem equivalents");
  }

  // V2 deployment patterns
  const deployPatterns = [
    { regex: /deployments\.fixture/g, label: "deployments.fixture (hardhat-deploy v1)" },
    { regex: /getNamedAccounts/g, label: "getNamedAccounts (hardhat-deploy v1)" },
    { regex: /hre\.deployments/g, label: "hre.deployments (hardhat-deploy v1)" },
  ];
  const deployHits = searchFiles(deployPatterns);
  if (deployHits.length > 0) {
    finding(SEV.MEDIUM, "hardhat-deploy v1 patterns in source", `${deployHits.length} hits in ${[...new Set(deployHits.map(h => h.file))].length} files`,
      "These patterns require hardhat-deploy v2/rocketh migration or Ignition rewrite",
      "Choose deploy migration path: hardhat-deploy v2 or Ignition");
  }

  // V2 compile references in scripts
  const pkgRaw = read("package.json");
  if (pkgRaw) {
    const pkg = JSON.parse(pkgRaw);
    const scripts = pkg.scripts || {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd === "string" && cmd.includes("hardhat compile")) {
        finding(SEV.LOW, `package.json script uses "hardhat compile"`, `scripts.${name}: "${cmd}"`,
          "V3 uses 'hardhat build' instead of 'hardhat compile'",
          `Update to: hardhat build`);
      }
    }
  }

  // hre.ethers global assumption
  const hrePatterns = [{ regex: /hre\.ethers\./g, label: "hre.ethers.* (ambient runtime assumption)" }];
  const hreHits = searchFiles(hrePatterns);
  if (hreHits.length > 0) {
    finding(SEV.MEDIUM, "Ambient hre.ethers usage detected", `${hreHits.length} hits across source/test files`,
      "V3 prefers explicit network connections over ambient hre extensions",
      "Use Mocha+ethers toolbox to preserve, or refactor to explicit connections");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECK 6: EXECUTION CHECKS
// ═══════════════════════════════════════════════════════════════════════════════
function checkExecution() {
  if (args["no-exec"]) {
    finding(SEV.INFO, "Execution checks skipped", "--no-exec flag", "Skipped by user request", "None");
    return;
  }

  // Check Node version
  const nodeVer = safeExec("node --version");
  if (typeof nodeVer === "string") {
    const major = parseInt(nodeVer.replace("v", ""));
    if (major < 18) {
      finding(SEV.BLOCKER, "Node.js version too old", `Node ${nodeVer}`, "Hardhat V3 requires Node 18.19+, recommends 22+", "Upgrade Node.js");
    } else if (major < 22) {
      finding(SEV.LOW, "Node.js version below recommended", `Node ${nodeVer}`, "Hardhat V3 recommends Node 22+", "Consider upgrading");
    } else {
      finding(SEV.INFO, "Node.js version OK", `Node ${nodeVer}`, "Meets V3 requirements", "None");
    }
  }

  // Hardhat version check
  if (exists("node_modules")) {
    const hhVer = safeExec("npx hardhat --version");
    if (typeof hhVer === "string" && hhVer.match(/\d+\.\d+/)) {
      finding(SEV.INFO, "Hardhat runtime version", hhVer.trim(), "Installed Hardhat version", "None");
    } else if (hhVer?.error) {
      finding(SEV.HIGH, "Hardhat failed to run", hhVer.stderr?.slice(0, 200) || "Unknown error",
        "Hardhat binary failed — migration may be broken", "Check config and dependencies");
    }

    // Config load test
    const configTest = safeExec("npx hardhat --help");
    if (configTest?.error) {
      finding(SEV.HIGH, "Hardhat config failed to load", configTest.stderr?.slice(0, 300) || "Config load error",
        "Config is invalid or has import/module errors", "Fix config errors — this blocks all Hardhat operations");
    } else {
      finding(SEV.INFO, "Hardhat config loads successfully", "npx hardhat --help succeeded", "Config is loadable", "None");
    }
  } else {
    finding(SEV.LOW, "node_modules not found", "Dependencies not installed",
      "Cannot run execution checks without installed dependencies", "Run npm install first, then re-run validator");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTING
// ═══════════════════════════════════════════════════════════════════════════════
function generateReport() {
  const sorted = [...findings].sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const filtered = args["include-low"] ? sorted : sorted.filter(f => SEV[f.severity] <= SEV.MEDIUM);
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const blockers = findings.filter(f => f.severity === "BLOCKER").length;
  const highs = findings.filter(f => f.severity === "HIGH").length;
  const overallStatus = blockers > 0 ? "FAIL" : highs > 0 ? "WARN" : "PASS";

  const report = {
    validator: "hardhat-v3-migration-validator",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    project: ROOT,
    overallStatus,
    summary: { total: findings.length, ...counts },
    context: {
      hardhatVersion: ctx.hardhatVersion,
      moduleType: ctx.moduleType,
      configFile: ctx.configFile,
      packageManager: ctx.packageManager,
      deployStack: ctx.deployStack,
      plugins: ctx.plugins,
    },
    findings: sorted,
  };
  return { report, filtered };
}

function renderMarkdown(report) {
  const statusIcon = { PASS: "✅", WARN: "⚠️", FAIL: "❌" };
  const lines = [];
  lines.push(`# Hardhat V3 Migration Validator Report`);
  lines.push(`\n**Scanned:** ${report.timestamp}`);
  lines.push(`**Project:** \`${report.project}\``);
  lines.push(`**Overall:** ${statusIcon[report.overallStatus] || "?"} **${report.overallStatus}**\n`);
  lines.push(`## Summary\n`);
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|-------|`);
  for (const s of SEV_LABEL) {
    if (report.summary[s]) lines.push(`| ${s} | ${report.summary[s]} |`);
  }
  lines.push(`| **Total** | **${report.summary.total}** |\n`);
  // Context
  lines.push(`## Project Context\n`);
  lines.push(`| Property | Value |`);
  lines.push(`|----------|-------|`);
  const c = report.context;
  lines.push(`| Hardhat Version | \`${c.hardhatVersion || "not found"}\` |`);
  lines.push(`| Module System | ${c.moduleType || "unknown"} |`);
  lines.push(`| Config File | ${c.configFile || "not found"} |`);
  lines.push(`| Package Manager | ${c.packageManager || "unknown"} |`);
  lines.push(`| Deploy Stack | ${c.deployStack || "none detected"} |`);

  // Plugin matrix
  if (c.plugins.length > 0) {
    lines.push(`\n## Plugin Matrix\n`);
    lines.push(`| Plugin | Package | Version | Status |`);
    lines.push(`|--------|---------|---------|--------|`);
    for (const p of c.plugins) {
      const icon = p.status === "PASS" ? "✅" : p.status === "BLOCKED" ? "🔴" : p.status === "NEEDS_REVIEW" ? "🟡" : "⚪";
      lines.push(`| ${p.name} | \`${p.package}\` | ${p.version} | ${icon} ${p.status} |`);
    }
  }
  // Findings
  const showFindings = args["include-low"] ? report.findings : report.findings.filter(f => SEV[f.severity] <= SEV.MEDIUM);
  if (showFindings.length > 0) {
    lines.push(`\n## Findings\n`);
    for (const f of showFindings) {
      const icon = SEV_ICON[SEV[f.severity]] || "⚪";
      lines.push(`### ${icon} ${f.id}: ${f.title}\n`);
      lines.push(`- **Severity:** ${f.severity}`);
      lines.push(`- **Confidence:** ${f.confidence}`);
      lines.push(`- **Evidence:** ${f.evidence}`);
      lines.push(`- **Why it matters:** ${f.why}`);
      lines.push(`- **Remediation:** ${f.fix}\n`);
    }
  }

  // Remediation order
  const actionable = report.findings.filter(f => SEV[f.severity] <= SEV.MEDIUM && f.fix !== "None");
  if (actionable.length > 0) {
    lines.push(`## Suggested Remediation Order\n`);
    actionable.forEach((f, i) => {
      lines.push(`${i + 1}. **[${f.severity}]** ${f.title} — ${f.fix}`);
    });
  }
  lines.push(`\n---\n*Generated by hardhat-v3-migration-validator v1.0.0*`);
  return lines.join("\n");
}

function printConsole(report) {
  const bar = "═".repeat(60);
  const statusIcon = { PASS: "✅", WARN: "⚠️", FAIL: "❌" };
  console.log(`\n${bar}`);
  console.log(`  hardhat-v3-migration-validator`);
  console.log(`  ${report.timestamp}`);
  console.log(`${bar}`);
  console.log(`  Project:  ${report.project}`);
  console.log(`  Status:   ${statusIcon[report.overallStatus]} ${report.overallStatus}`);
  console.log(`${bar}`);
  console.log(`  BLOCKER: ${report.summary.BLOCKER || 0}  HIGH: ${report.summary.HIGH || 0}  MEDIUM: ${report.summary.MEDIUM || 0}  LOW: ${report.summary.LOW || 0}  INFO: ${report.summary.INFO || 0}`);
  console.log(`${bar}\n`);
  // Top findings
  const top = report.findings.filter(f => SEV[f.severity] <= SEV.MEDIUM).slice(0, 8);
  if (top.length > 0) {
    console.log("  Top findings:");
    for (const f of top) {
      const icon = SEV_ICON[SEV[f.severity]];
      console.log(`    ${icon} ${f.id} [${f.severity}] ${f.title}`);
    }
    console.log("");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
function main() {
  console.log(`Scanning: ${ROOT}`);
  checkPackage();
  checkModuleSystem();
  checkConfig();
  checkPlugins();
  checkSourceTests();
  checkExecution();

  const { report } = generateReport();
  printConsole(report);

  // Write JSON
  const jsonPath = join(ROOT, "hardhat-v3-validator-report.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`  JSON report:     ${jsonPath}`);

  // Write Markdown
  const mdPath = join(ROOT, "hardhat-v3-validator-report.md");
  writeFileSync(mdPath, renderMarkdown(report));
  console.log(`  Markdown report: ${mdPath}`);
  console.log("");

  // Exit code
  const blockers = findings.filter(f => f.severity === "BLOCKER").length;
  const highs = findings.filter(f => f.severity === "HIGH").length;
  if (blockers > 0) process.exit(2);
  if (highs > 0) process.exit(1);
  process.exit(0);
}

main();
