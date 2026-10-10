# VoiceDrive PBX gateway: Asterisk 23 with PJSIP WebRTC, ARI and Postgres realtime.
# Pinned by digest so a rebuild gets the same Asterisk.
FROM andrius/asterisk@sha256:40c285e0332899ff5b6f77e4545aac754efe52bfb7eccfb76cd23f43d7d5e7a6

COPY conf/ /opt/voicedrive/conf/
COPY entrypoint.sh /usr/local/bin/voicedrive-entrypoint.sh
RUN chmod +x /usr/local/bin/voicedrive-entrypoint.sh && mkdir -p /etc/asterisk/vd && chown -R asterisk:asterisk /etc/asterisk/vd

ENTRYPOINT ["/usr/local/bin/voicedrive-entrypoint.sh"]
CMD ["/usr/sbin/asterisk", "-f", "-T", "-W", "-U", "asterisk", "-p", "-vvv"]
