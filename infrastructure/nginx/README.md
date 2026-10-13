# nginx vhost

`api.conf` terminates TLS for `${API_HOST}` and proxies to the app on `127.0.0.1:3022`. The file in the repo is exactly what runs on the host — certbot does not edit it (webroot authenticator, not the nginx installer).

First-time setup on a fresh host (DNS must already point at it):

```bash
apt install -y nginx certbot
# the stock default site serves /var/www/html on :80, which is enough for the first challenge
certbot certonly --webroot -w /var/www/html -d ${API_HOST} \
  --non-interactive --agree-tos -m <email> --deploy-hook "systemctl reload nginx"
cp api.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/api.conf /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

After changing the file: copy it over the host copy, then `nginx -t && systemctl reload nginx`. Renewal runs from `certbot.timer` (`systemctl list-timers | grep certbot`); `certbot renew --dry-run` checks it.
