# nginx vhost

`api.conf` terminates TLS for the API host and proxies to the app on `127.0.0.1:3022`. The repo names no host: the file carries `${API_HOST}` placeholders, and the host copy is the file with them filled in (the `sed` below) — otherwise exactly what runs on the host; certbot does not edit it (webroot authenticator, not the nginx installer).

`redacted-log-format.conf` defines the `redacted` access-log format (`combined` without the query string and the referer, both of which carry `?verifyBearerToken=`) and goes to `/etc/nginx/conf.d/`. Both server blocks of the vhost log with it, so it must be installed before the vhost is loaded, or `nginx -t` fails with `unknown log format "redacted"`.

First-time setup on a fresh host (DNS must already point at it):

```bash
API_HOST=<the API host name>
apt install -y nginx certbot
# the stock default site serves /var/www/html on :80, which is enough for the first challenge
certbot certonly --webroot -w /var/www/html -d "$API_HOST" \
  --non-interactive --agree-tos -m <email> --deploy-hook "systemctl reload nginx"
cp redacted-log-format.conf /etc/nginx/conf.d/
sed "s|\${API_HOST}|$API_HOST|g" api.conf > /etc/nginx/sites-available/api.conf
ln -s /etc/nginx/sites-available/api.conf /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

After changing either file: copy it over the host copy (`redacted-log-format.conf` first, if both changed; `api.conf` through the same `sed`), then `nginx -t && systemctl reload nginx`. Renewal runs from `certbot.timer` (`systemctl list-timers | grep certbot`); `certbot renew --dry-run` checks it.

Access logs written before the `redacted` format was installed contain the token: clear them once after the reload, `truncate -s0 /var/log/nginx/access.log /var/log/nginx/access.log.1 && rm -f /var/log/nginx/access.log.*.gz`. `error.log` has no configurable format and still records the full request line and referer of a request that fails upstream (e.g. 502 during a deploy's container swap); see `docs/backlog/admin-token-in-url.md`.
