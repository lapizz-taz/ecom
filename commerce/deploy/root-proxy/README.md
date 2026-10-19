# Root-domain proxy (shop.com without www, at any DNS company)

Cloudflare for SaaS connects a store domain through a CNAME record. A root domain
(`shop.com`) cannot have a CNAME at most DNS companies, and at DNS companies that run on
Cloudflare themselves (Hostinger, for one) it can never be verified. Shopify solves this
with a fixed IP for an A record; this proxy is ours.

```
visitor → shop.com (A record → this server) → Caddy (HTTPS for shop.com) → stores.fullfilio.com (Worker)
```

Subdomains (`www.shop.com`) keep using the CNAME to `stores.fullfilio.com`.

## Set up (about 15 minutes)

1. **A small server with a fixed public IPv4** (1 vCPU / 1 GB is plenty to start), for example
   Hetzner, DigitalOcean, Vultr or Lightsail. Open ports 80 and 443 (TCP) and 443 (UDP).
2. On the server, one line opens the ports, installs Docker, writes these files to
   `/opt/fullfilio-root-proxy` with a new `PROXY_SECRET`, starts Caddy and prints the secret
   (safe to run again; it keeps the secret):
   ```sh
   curl -fsSL https://fullfilio.com/downloads/root-proxy/install.sh | sudo bash -s -- you@example.com
   ```
   Or by hand: install Docker, copy this folder to the server, then
   `cp .env.example .env` (fill in ACME_EMAIL and PROXY_SECRET from `openssl rand -hex 32`)
   and `docker compose up -d`.
3. In Cloudflare → Workers → **fullfilio** → Settings → Variables and secrets, add:
   - `ROOT_PROXY_SECRET` = the same `PROXY_SECRET` (secret)
   - `ROOT_DOMAIN_IP` = the server's IPv4 (and `ROOT_DOMAIN_IPV6` if it has a fixed IPv6)
4. That's it: root domains now show **A @ → that IP** in Website → Domains, and go live
   by themselves once the record is in place (the first visit gets the certificate).

## How it stays safe

- Caddy asks `GET https://fullfilio.com/functions/v1/domains?domain=…` before each new
  certificate; only domains connected to a store get one.
- The Worker trusts `X-Fullfilio-Host` / `X-Fullfilio-Client-IP` only together with
  `X-Fullfilio-Proxy` = `ROOT_PROXY_SECRET`; without it the headers are dropped.

## Check it

```sh
curl -sI https://shop.com | grep -i x-fullfilio     # the store answers
docker compose logs -f caddy                        # certificates being issued
```
