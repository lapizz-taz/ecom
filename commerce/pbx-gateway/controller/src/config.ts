// Settings from the environment (see ../.env.example).
export interface Config {
  apiUrl: string
  gatewayToken: string
  ariUrl: string
  ariUser: string
  ariPassword: string
  trunksFile: string
  trunkSyncSeconds: number
  pingSeconds: number
  wsTransport: string
  trunksOwner: { uid: number; gid: number } | null
}

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

export function loadConfig(): Config {
  return {
    apiUrl: need('VD_API_URL').replace(/\/+$/, ''),
    gatewayToken: need('VD_GATEWAY_TOKEN'),
    ariUrl: (process.env.ARI_URL ?? 'http://127.0.0.1:8088/ari').replace(/\/+$/, ''),
    ariUser: process.env.ARI_USER ?? 'voicedrive',
    ariPassword: need('ARI_PASSWORD'),
    trunksFile: process.env.TRUNKS_FILE ?? '/vd/trunks.conf',
    trunkSyncSeconds: Number(process.env.TRUNK_SYNC_SECONDS ?? 60),
    pingSeconds: Number(process.env.PING_SECONDS ?? 30),
    wsTransport: process.env.WS_TRANSPORT ?? 'transport-wss',
    // uid:gid of the asterisk user, when the controller runs as another user.
    trunksOwner: /^\d+:\d+$/.test(process.env.TRUNKS_OWNER ?? '')
      ? { uid: Number(process.env.TRUNKS_OWNER!.split(':')[0]), gid: Number(process.env.TRUNKS_OWNER!.split(':')[1]) } : null,
  }
}
