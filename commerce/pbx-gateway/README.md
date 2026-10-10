# VoiceDrive PBX gateway

The gateway connects your staff's browser phones (WebRTC) to the IPTSP's SIP
trunk. It is three containers on one Linux server:

| Container | What it does |
|---|---|
| `asterisk` | Asterisk 23. Softphones connect with `wss://<host>:8089/ws`. Trunks register to the IPTSP over UDP/TCP 5060. |
| `controller` | Node.js app that runs every call. It asks the Fullfilio app whether a call may start, rings agents, bridges calls, times them, and reports how each one ended. Billing uses that report. It also keeps the trunk config in step with the app. |
| `coturn` | TURN relay so softphones on strict office or mobile networks still get audio. Its credentials are time-limited. |

```
Browser (SIP.js) ──wss──▶ Asterisk ◀──SIP/RTP──▶ IPTSP trunk (09xxx DID)
                             │ ARI (127.0.0.1)
                         controller ──HTTPS + gateway token──▶ Supabase edge function "voicedrive" ──▶ Postgres
Asterisk ──Postgres (read-only pbx_gw views)──▶ softphone logins
```

## Security model

- **Softphone passwords.** The app creates a random password each time a phone starts. The browser receives it once, and the database stores only its digest (`MD5(user:voicedrive:password)`) for 15 minutes. Asterisk reads that digest through the `pbx_gw` views, using a role that can read nothing else.
- **Trunk passwords.** These live in Supabase Vault. The controller receives them with the gateway token and writes them to a file that only the Asterisk user can read. They never reach a browser.
- **Call authorization.** Every outgoing call must be requested in the app first. The request is sent with the call as the `X-VD-Call-Id` header. At dial time the gateway checks the number, the balance, the channel limit, the paid seats and maintenance. Calls nobody requested are refused.
- **Billing.** Billing uses the gateway's own timing: whole seconds from the customer answering to hang-up, × 0.40 tk/60 + 15% VAT. Each call is charged once. A call is cut at the longest time the balance and the business's limit allow.

## 1. Server

- Linux VPS with a public IPv4 address. Docker and the Compose plugin installed.
- A domain name pointing to the server, for example `pbx.example.com`, with a TLS certificate. Let's Encrypt works:
  ```sh
  certbot certonly --standalone -d pbx.example.com
  ```
- Firewall:

  | Port | Open to |
  |---|---|
  | 8089/tcp | everyone (WSS for softphones) |
  | 10000–20000/udp | everyone (RTP audio) |
  | 3478/udp+tcp, 5349/tcp, 49160–49200/udp | everyone (TURN) |
  | 5060/udp+tcp | **only the IPTSP's IP addresses** |
  | 8088 (ARI) | nobody; it is bound to 127.0.0.1 |

## 2. Database access for the gateway

The migration creates the `pbx_gateway` role without login rights. In the Supabase SQL Editor, give it a password:

```sql
alter role pbx_gateway with login password 'a-long-random-password';
```

Connect through the **session** pooler (port 5432) with the user `pbx_gateway.<project-ref>`.

## 3. Settings in the app (Super Admin)

Go to **Settings → VoiceDrive PBX → Super Admin**.

1. **Gateway**
   - SIP domain: `pbx.example.com`
   - WebSocket: `wss://pbx.example.com:8089/ws`
   - TURN addresses: `turn:pbx.example.com:3478`, `turns:pbx.example.com:5349`
   - Save a **TURN secret** (the same value as `TURN_SECRET` below).
   - Click **New gateway token** and copy it. It is shown once.
2. **Business** (for each one)
   - DID / caller ID: `09639XXXXXX`
   - Trunk host and port, transport, SIP username and **trunk password**, all from your IPTSP contract.
   - Dial format: `LOCAL` (01XXXXXXXXX) unless the IPTSP asks for `+880` or `880`.
   - Switch the line on.

## 4. Start the gateway

```sh
cd pbx-gateway
cp .env.example .env      # fill in every value
docker compose up -d --build
docker compose logs -f controller
```

Within a minute the controller writes the trunks, registers them with the IPTSP and checks in. Then, in **Super Admin**, the business shows the gateway as online. Click **Confirm bridge ready**. The business can now buy a package and agents can start their phones under **My Setup**.

Useful checks:

```sh
docker compose exec asterisk asterisk -rx "pjsip show registrations"   # trunk Registered?
docker compose exec asterisk asterisk -rx "pjsip show contacts"        # online softphones
docker compose exec asterisk asterisk -rx "pjsip show endpoint vdtrunk-1"
```

## How calls flow

**Outgoing**
1. The agent clicks Call. The app checks the line, seat, balance and channels, and creates a call request.
2. The browser sends an INVITE with `X-VD-Call-Id`. Asterisk passes it to the controller.
3. The controller asks the app again (`gw_outbound_start`). Only then does it dial `PJSIP/<number>@vdtrunk-<business>` with the business DID as caller ID.
4. On answer the controller bridges both sides and starts the clock. On hang-up it reports `gw_ended`, and the app charges the call.

**Incoming**
1. A call arrives on the business trunk at its DID.
2. The app (`gw_inbound_start`) returns the available agents (online, marked available, within paid seats, not on a call) and the call group's strategy (ring all, or longest idle first).
3. The controller rings their softphones with `X-VD-Call-Id`. The browser uses that ID to show the caller's orders. The first agent to answer gets the call.
4. If nobody answers, the call is logged as a missed call (`NO_ANSWER`) and appears in **Missed & Callback**.

## Tests

- Unit tests (controller): `npx vitest run pbx-gateway`
- End-to-end (developer machine with the local Supabase stack): `test/` holds the fake IPTSP (a second Asterisk on 127.0.0.2:5070) and `setup-local.sql`. A real Chromium using SIP.js registers, makes an answered call (audio checked both ways), a busy call and a call nobody requested, and receives a call. The test then checks the charge and the ledger.

## Not covered by this gateway

- **Call recording.** Not enabled. Recording needs consent wording and a retention policy decided first.
- **Several gateways for one business.** Run one gateway per region.
