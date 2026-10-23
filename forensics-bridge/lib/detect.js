// 工具路径探测（radare2/retdec/tshark/mitmdump/trafilatura/single-file/monolith）
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const TOOLS_ROOT = 'D:\\插件研发\\tools'
const TOOLS_ROOT_FALLBACK = 'C:\\tools'
const PY_SCRIPTS = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python313\\Scripts'
const PY_EXE = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python313\\python.exe'
const NPM_GLOBAL = 'C:\\Users\\Administrator\\AppData\\Roaming\\npm'

function firstExisting(paths) {
  for (const p of paths) {
    try { if (existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

// PATH 探测：新机器上工具通常只装在 PATH 里（例如 C:\tools\radare2\...\bin）
function onPath(cmd, args) {
  try {
    const r = spawnSync(cmd, args || ['-v'], { windowsHide: true, stdio: 'ignore' })
    return r.status === 0 ? cmd : null
  } catch { return null }
}

function scanRadare2() {
  for (const toolsRoot of [TOOLS_ROOT, TOOLS_ROOT_FALLBACK]) {
    const root = join(toolsRoot, 'radare2')
    try {
      for (const ver of readdirSync(root)) {
        for (const exe of [join(root, ver, 'bin', 'radare2.exe'), join(root, ver, 'bin', 'r2.exe')]) {
          if (existsSync(exe)) return exe
        }
      }
    } catch { /* ignore */ }
  }
  return null
}

export function detectTools(config) {
  const radare2 = config.radare2Bin || scanRadare2() || firstExisting(['radare2.exe']) || onPath('radare2') || onPath('r2')
  const retdec = config.retdecBin || join(TOOLS_ROOT, 'retdec', 'bin', 'retdec-decompiler.exe')
  const tshark = config.tsharkBin || firstExisting([
    'C:\\Program Files\\Wireshark\\tshark.exe',
    'C:\\Program Files (x86)\\Wireshark\\tshark.exe',
  ]) || (() => { try { const r = spawnSync('tshark', ['--version'], { windowsHide: true, stdio: 'ignore' }); return r.status === 0 ? 'tshark' : null } catch { return null } })()
  const mitmdump = config.mitmdumpBin || join(PY_SCRIPTS, 'mitmdump.exe')
  const trafilatura = config.trafilaturaBin || join(PY_SCRIPTS, 'trafilatura.exe')
  const crawlPy = config.pythonVer || '3.13'
  const python = config.pythonBin || firstExisting([PY_EXE]) || onPath('python', ['--version'])
  const singleFile = config.singleFileBin || firstExisting([join(NPM_GLOBAL, 'single-file.cmd'), join(NPM_GLOBAL, 'single-file.exe'), 'single-file.cmd'])
  const monolith = config.monolithBin || firstExisting([join(TOOLS_ROOT, 'monolith.exe'), 'monolith.exe']) || onPath('monolith', ['--version'])
  return { radare2, retdec, tshark, mitmdump, trafilatura, crawlPy, python, singleFile, monolith }
}

export function pyScriptsDir() {
  return PY_SCRIPTS
}

export function pythonPath() {
  return PY_EXE
}

export function npmGlobalDir() {
  return NPM_GLOBAL
}

export function toolsRoot() {
  return TOOLS_ROOT
}
