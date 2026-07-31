import { spawn } from 'node:child_process'
const siteUrl = 'http://127.0.0.1:4173'

console.log(`Private workbench: ${siteUrl}`)

async function isUrlRunning(url) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

if (await isUrlRunning(siteUrl)) {
  console.log(`Private workbench is already running at ${siteUrl}`)
  process.exit(0)
}

const child = spawn(
  'npm',
  ['--prefix', 'sites-app', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '4173'],
  { shell: true, stdio: 'pipe' },
)

child.stdout.on('data', (data) => process.stdout.write(`[workbench] ${data}`))
child.stderr.on('data', (data) => process.stderr.write(`[workbench] ${data}`))
child.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`Private workbench exited with code ${code}`)
  }
})

function shutdown() {
  child.kill()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
