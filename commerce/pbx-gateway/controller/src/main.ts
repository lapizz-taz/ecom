// VoiceDrive gateway controller: connects Asterisk (ARI) to the VoiceDrive app.
import { chown, readFile, rename, writeFile } from 'node:fs/promises'
import { HttpApi } from './api.ts'
import { AriClient } from './ari.ts'
import { CallManager } from './calls.ts'
import { loadConfig } from './config.ts'
import { log } from './log.ts'
import { renderTrunks } from './trunks.ts'

const cfg = loadConfig()
const ari = new AriClient(cfg.ariUrl, cfg.ariUser, cfg.ariPassword)
const api = new HttpApi(cfg.apiUrl, cfg.gatewayToken)
const calls = new CallManager(ari, api)
let asteriskVersion = 'unknown'
let lastTrunkSync: { at: string; trunks: number; error?: string } | null = null

/** Writes the trunks file and reloads PJSIP only when it changed. */
async function syncTrunks(): Promise<void> {
  try {
    const trunks = await api.trunks()
    const conf = renderTrunks(trunks)
    const current = await readFile(cfg.trunksFile, 'utf8').catch(() => '')
    if (conf !== current) {
      await writeFile(`${cfg.trunksFile}.tmp`, conf, { mode: 0o640 })
      // Asterisk must be able to read it; nobody else needs to (it holds trunk passwords).
      if (cfg.trunksOwner) await chown(`${cfg.trunksFile}.tmp`, cfg.trunksOwner.uid, cfg.trunksOwner.gid)
      await rename(`${cfg.trunksFile}.tmp`, cfg.trunksFile)
      await ari.request('PUT', '/asterisk/modules/res_pjsip.so')
      await ari.request('PUT', '/asterisk/modules/res_pjsip_outbound_registration.so').catch(() => undefined)
      log('info', 'trunks updated', { trunks: trunks.length })
    }
    lastTrunkSync = { at: new Date().toISOString(), trunks: trunks.length }
  } catch (error) {
    lastTrunkSync = { at: new Date().toISOString(), trunks: 0, error: (error as Error).message }
    log('error', 'trunk sync failed', { error: (error as Error).message })
  }
}

async function ping(): Promise<void> {
  try {
    const info = await ari.request<{ system?: { version?: string } }>('GET', '/asterisk/info')
    asteriskVersion = info?.system?.version ?? asteriskVersion
    const endpoints = await ari.request<Array<{ resource: string; state: string }>>('GET', '/endpoints/PJSIP')
    const trunks = endpoints.filter((e) => e.resource.startsWith('vdtrunk-')).map((e) => ({ name: e.resource, state: e.state }))
    const softphonesOnline = endpoints.filter((e) => /^vd\d+x\d+$/.test(e.resource) && e.state === 'online').length
    await api.ping(`Asterisk ${asteriskVersion}`, { trunks, softphonesOnline, activeCalls: calls.activeCalls, trunkSync: lastTrunkSync })
  } catch (error) {
    log('error', 'health ping failed', { error: (error as Error).message })
  }
}

ari.listen('voicedrive', (e) => void calls.onEvent(e), () => { void syncTrunks(); void ping() })
setInterval(() => void syncTrunks(), cfg.trunkSyncSeconds * 1000)
setInterval(() => void ping(), cfg.pingSeconds * 1000)
log('info', 'VoiceDrive controller started', { api: cfg.apiUrl, ari: cfg.ariUrl })

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { log('info', 'stopping', { sig }); process.exit(0) })
