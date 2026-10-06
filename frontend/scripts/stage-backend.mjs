// Stages a lean copy of the compiled backend for electron-builder (see extraResources in electron-builder.yml).
//
// Copying backend-node/node_modules wholesale ships everything `npm install` put there: the dev tooling
// (typescript, vite, esbuild, rollup, vitest, tsx ...) and onnxruntime-node's native binaries for every
// OS/arch. The installed app needs neither, so this copies only:
//   - dist/ and package.json (the compiled server; source maps are dropped, their sources are not shipped)
//   - the production dependency closure, as resolved by `npm ls --omit=dev` (no dev-only package can slip in)
//   - onnxruntime-node's native binary for the platform/arch this installer is being built for
//
// Nothing is modified: the dependency versions, the onnxruntime binaries kept, and the model loading code
// are exactly what the backend already uses; this only leaves out files the target machine cannot use.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendDir = path.resolve(frontendDir, '..', 'backend-node')
const stageDir = path.join(frontendDir, 'build', 'backend')

function fail(message) {
  console.error(`[stage-backend] ${message}`)
  process.exit(1)
}

if (!existsSync(path.join(backendDir, 'dist', 'server.js'))) fail('backend-node/dist/server.js is missing: run `npm run backend:build` first.')

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })

cpSync(path.join(backendDir, 'dist'), path.join(stageDir, 'dist'), {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
})
cpSync(path.join(backendDir, 'package.json'), path.join(stageDir, 'package.json'))

// Production closure: every package directory npm resolves for `dependencies` (transitively).
// Under `npm run`, npm_execpath is npm's own CLI script: running it with node avoids a shell (npm is a
// .cmd shim on Windows). Run directly, fall back to the shim, whose arguments are all constants.
const npmCli = process.env.npm_execpath
const lsArgs = ['ls', '--omit=dev', '--all', '--parseable']
const listing = execFileSync(
  npmCli ? process.execPath : 'npm',
  npmCli ? [npmCli, ...lsArgs] : lsArgs,
  { cwd: backendDir, encoding: 'utf8', shell: !npmCli && process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 },
)
const modulesRoot = path.join(backendDir, 'node_modules') + path.sep
const packageDirs = listing
  .split(/\r?\n/)
  .map((line) => path.normalize(line.trim()))
  .filter((dir) => dir.startsWith(modulesRoot))
  // A nested package (a/node_modules/b) is copied along with its top-level parent.
  .filter((dir, _index, all) => !all.some((other) => other !== dir && dir.startsWith(other + path.sep)))

if (packageDirs.length === 0) fail('npm reported no production dependencies; is backend-node/node_modules installed?')

for (const dir of packageDirs) {
  cpSync(dir, path.join(stageDir, 'node_modules', path.relative(modulesRoot, dir)), { recursive: true })
}

// onnxruntime-node ships one native folder per OS/arch; only this build's can ever be loaded.
const napiDir = path.join(stageDir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3')
if (existsSync(napiDir)) {
  const keep = path.join(napiDir, process.platform, process.arch)
  if (!existsSync(keep)) fail(`onnxruntime-node has no native binary for ${process.platform}/${process.arch}; refusing to stage a backend that cannot load its runtime.`)
  for (const platform of readdirSync(napiDir)) {
    for (const arch of readdirSync(path.join(napiDir, platform))) {
      const dir = path.join(napiDir, platform, arch)
      if (dir !== keep) rmSync(dir, { recursive: true, force: true })
    }
    const platformDir = path.join(napiDir, platform)
    if (readdirSync(platformDir).length === 0) rmSync(platformDir, { recursive: true, force: true })
  }
}

function sizeOf(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const entryPath = path.join(dir, entry.name)
    return sum + (entry.isDirectory() ? sizeOf(entryPath) : statSync(entryPath).size)
  }, 0)
}
console.log(`[stage-backend] staged ${packageDirs.length} production packages -> ${path.relative(frontendDir, stageDir)} (${(sizeOf(stageDir) / 1048576).toFixed(1)} MB)`)
