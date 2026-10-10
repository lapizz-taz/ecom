#!/bin/sh
# Renders the config templates from environment variables, then starts Asterisk.
set -eu

need() { eval "v=\${$1:-}"; [ -n "$v" ] || { echo "VoiceDrive gateway: $1 is required" >&2; exit 1; }; }
need ARI_PASSWORD
need DB_HOST
need DB_NAME
need DB_USER
need DB_PASSWORD
need EXTERNAL_IP

export DB_PORT="${DB_PORT:-5432}"
export DB_SSLMODE="${DB_SSLMODE:-require}"
export LOCAL_NET="${LOCAL_NET:-10.0.0.0/8}"
export RTP_START="${RTP_START:-10000}"
export RTP_END="${RTP_END:-20000}"
export SIP_PORT="${SIP_PORT:-5060}"
export HTTP_PORT="${HTTP_PORT:-8088}"
export HTTP_BIND="${HTTP_BIND:-127.0.0.1}"
export HTTPS_PORT="${HTTPS_PORT:-8089}"
export STUN_ADDR="${STUN_ADDR:-}"

# WebRTC needs WSS in production. Without a certificate (local tests only) the
# same transport name serves plain WS.
if [ -n "${TLS_CERT:-}" ] && [ -n "${TLS_KEY:-}" ]; then
  export WS_PROTOCOL=wss TLS_ENABLE=yes
else
  echo "VoiceDrive gateway: no TLS_CERT/TLS_KEY — WebSocket without TLS (local testing only)" >&2
  export WS_PROTOCOL=ws TLS_ENABLE=no TLS_CERT=/dev/null TLS_KEY=/dev/null
fi

# libpq (res_config_pgsql) reads the TLS mode from the environment.
export PGSSLMODE="$DB_SSLMODE"

# Only our variables are substituted; dialplan ${EXTEN} etc. stay as written.
VARS='$HTTP_BIND $ARI_PASSWORD $DB_HOST $DB_PORT $DB_NAME $DB_USER $DB_PASSWORD $EXTERNAL_IP $LOCAL_NET $RTP_START $RTP_END $SIP_PORT $HTTP_PORT $HTTPS_PORT $STUN_ADDR $WS_PROTOCOL $TLS_ENABLE $TLS_CERT $TLS_KEY'
for f in /opt/voicedrive/conf/*.conf; do
  envsubst "$VARS" < "$f" > "/etc/asterisk/$(basename "$f")"
done
# Trunks are written here by the controller; start empty.
[ -f /etc/asterisk/vd/trunks.conf ] || : > /etc/asterisk/vd/trunks.conf
# Without a STUN server Asterisk must not try one (each try delays a call by seconds).
[ -n "$STUN_ADDR" ] || sed -i '/^stunaddr/d' /etc/asterisk/rtp.conf
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk 2>/dev/null || true
chmod 640 /etc/asterisk/res_pgsql.conf /etc/asterisk/ari.conf

exec "$@"
