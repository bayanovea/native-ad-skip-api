# Hosting selection after the Yandex Cloud outage (October 2026)

> **Status 2026-10-15: migrated.** Prod runs on Timeweb Cloud **Almaty** (`ala-1`, `${HOST_IP}`) — Novosibirsk had no free capacity that day, so the documented exit location was used. DNS, TLS, first deploy and RU mobile/wired reachability verified; nightly S3 backups still open (`docs/backlog/offhost-pg-backup-s3.md`). See `docs/plans/completed/20261014-timeweb-migration.md`.

Date: 2026-10-14. Follow-up to `20261013-yandex-cloud-outage-analysis.md`.

## TL;DR

- **Decision: Timeweb Cloud, Novosibirsk location.** Resources are available this week, hourly billing, snapshots/API, outside the drone-strike ring around Moscow, and the same control panel also offers Almaty if we ever want to leave RF.
- Digital Ocean is rejected even as a stopgap: its whole AS14061 is on Roskomnadzor TSPU lists, nothing we configure on a droplet changes that, and a Russian nginx front in front of DO is the same amount of work as a real migration.
- Kazakhstan (Timeweb/RUVDS Almaty) was the best non-RF option but loses on 152-FZ localization once payments appear, on a 50% price premium, and on a single cross-border path.
- Selectel and prv Cloud are the official landing zones for Yandex clients and are queueing / failing resource creation right now. Revisit in 2–3 weeks if needed.

## Why Digital Ocean was unreachable from Russia (and why region does not help)

Four layers, all enforced inside Russian ISPs by TSPU (DPI boxes at every operator). Server geography is irrelevant to all of them.

1. **2018 registry blocks of DO prefixes** (167.99.0.0/16, 206.189.0.0/16, others) during the Telegram sweep; many never lifted.
2. **May 2022: TCP/443 SYN drops** to DO and Cloudflare networks on Beeline, Rostelecom, Dom.ru etc.
3. **April 2024: DigitalOcean LLC formally restricted** under the "grounding" law (406-FZ). Real driver: DO is the top host for Russians' personal VPNs.
4. **June 2025: AS14061 on the TSPU throttle list** (connections hang after ~16 KB) alongside Cloudflare, Hetzner, OVH; patchy per ISP. **2026:** behavioural DPI since Feb, RKN/FSB direct TSPU control since March (resolution 1667), whole datacenter ranges in DE/NL/FR/UK/US blackholed or throttled since August, mobile-internet "whitelist" shutdowns reach only Russian resources.

Our API (plain HTTP on :3022, JSON < 16 KB) dodges the 443-only and 16 KB rules but not IP/prefix/ASN blocks, which are now the dominant mechanism.

**Droplet parameters:** region, size, image, IPv6, Reserved IP do not matter. TSPU keys on IP/prefix/ASN/port/SNI. All DO regions share AS14061. A new droplet or Reserved IP is a lottery for an unblocked prefix, not a guarantee.

**Old droplet facts:** `134.122.73.229`, FRA1, prefix 134.122.64.0/20, still up, ports 22/80/443/3022 open, `GET /` on :3022 returns `{"status":"ok"}`. check-host Moscow/SPb nodes reach it, but those are datacenter vantage points (AS14576, AS210644) that bypass residential TSPU, so this proves nothing about users. The only meaningful test is a curl from a Russian phone on mobile data and from a home wired ISP.

**Estimate of affected RU users on DO:** ~55% on an ordinary day (30–60% band), 80–90% during blocking waves. Logic: 85–95% of subscribers are behind operators that apply the rules; 50/50 prior that our /20 is in a block list given we already observed outages; IP-level block hits ~90%, ASN-level throttling alone hits ~25%.

## Non-RF options considered

Hosting outside RF with "max availability" does not exist; the nearest class is Kazakhstan/Belarus via RKN-registered Russian hosters (their AS is treated as domestic, KZ/BY prefixes are not VPN hotspots, RU cards accepted).

| Option | RTT to Moscow | Notes |
|---|---|---|
| RUVDS Almaty/Astana | 40–60 ms | Transtelecom DC, Karasai Batyra 55; from 149 ₽ (HDD), Turbo 1 2 vCPU/4 GB/40 GB SSD 2 560 ₽, per-second configurator ~3 000 ₽; monthly billing, 10% retention fee on unspent balance; IP geolocation complaints; support 10 min to weeks; 100 Mbit/s, 150 GB/day cap |
| Timeweb Cloud Almaty | 40–60 ms | **Same building** (Transtelecom, Karasai Batyra 55); KZ-40 4 230 ₽, KZ-50 5 620 ₽ (≈ +50% vs Moscow); hourly, snapshots, API/Terraform, KZ IPs, IPv6 free; 100 Mbit/s |
| RUVDS / hoster.by Minsk | 15–30 ms | new sites, provisioning delays reported |
| Yandex Cloud kz1 (Karaganda) | 50–70 ms | separate account + tenge billing; Yandex in crisis |

Do not use NL/DE/FI/FR locations of anyone (incl. Timeweb AMS/FRA): exactly the ranges being subnet-blocked.

**Drawbacks of KZ vs an RF datacenter:**
- 152-FZ: primary storage of RU citizens' PD must be in RF. `prv_user_id` counts as PD in RKN practice. Theoretical for a pet project, real once payments exist (ИП/юрлицо, ЮKassa, names/emails). Fines since 30 May 2025 up to 6 M ₽ for legal entities. Cross-border transfer to KZ is allowed (adequate-protection list) but needs RKN notification.
- Mobile-internet whitelists exclude any foreign IP (but also exclude any small RU-hosted project).
- TSPU rules may extend to KZ prefixes if VPN hosting moves there.
- Single cross-border path (TTK / Kazakhtelecom).
- Price premium ~50%.
- Not a drawback: the 2024 "foreign hosting ban" binds hosters, not site owners; Timeweb and RUVDS are in the RKN registry.

## RF options and resource availability as of 2026-10-14

| Provider | Resources now | Sites | 2 vCPU / 4 GB / 40–50 GB | Billing |
|---|---|---|---|---|
| Selectel | status page: resource creation failures in pools ru-6/7/8, support under "unprecedented load", SBP payment issues; Habr: queues for manual node allocation | Moscow, SPb, Leningrad obl., partner DC Novosibirsk | cloud from ~950 ₽, cheap VDS line from 200 ₽ | hourly |
| prv Cloud | manual node allocation queues for migrating stateful services | Moscow (Domodedovo), SPb | constructor, from ~150 ₽ | per minute |
| K2Cloud | enterprise, priority to Yandex clients | Moscow | n/a | contract |
| **Timeweb Cloud** | status page green for SPb/Moscow/Novosibirsk, no restriction notices | SPb, Moscow, **Novosibirsk** | Cloud 50 3 840 ₽ (Cloud 30, 2 GB, 730 ₽) | hourly, min top-up small |
| Beget | no restriction notices found; status page did not resolve | SPb only | 2/4/40 NVMe 990 ₽, 1 Gbit/s | daily |
| RUVDS | no notices | Korolev, Moscow, SPb, Kazan, Ekaterinburg, Novosibirsk, Omsk, Krasnodar, Vladivostok | Turbo 1 2 560 ₽ | monthly / per-second |
| REG.RU | reportedly untouched by the June 2026 TSPU wave; tariff page did not render | Moscow | see site | monthly |

Hardware prices +10–15% in a week and no server deliveries until year end per press; irrelevant for a 2-vCPU VM carved from existing hosts.

**Physical risk:** Sasovo, Kaluga, Vladimir form a 200–300 km ring around Moscow. Moscow/SPb DCs are intact but in range. Novosibirsk (Timeweb, Selectel partner, RUVDS), Ekaterinburg and Omsk (RUVDS) are not. Novosibirsk→Moscow ≈ 50 ms, irrelevant for us.

**What no RF host solves:** mobile whitelists (~500 large services). The June 2026 TSPU wave hit Timeweb/Beget/Selectel ASNs via TLS fingerprint + parallel-session triggers; our plain-HTTP API does not trip them.

## Decision and sizing

- Timeweb Cloud, Novosibirsk. Start with Cloud 50 (2 vCPU / 4 GB / 50 GB NVMe, 3 840 ₽/mo) to hold app + Postgres + Prometheus + Grafana on one box; Cloud 30 (730 ₽) only if monitoring is trimmed.
- Keep the Almaty option in the same panel as the exit route if RF hosting becomes untenable.
- Backup choice if Timeweb cannot provision on the day: Beget SPb (price) or RUVDS Novosibirsk/Ekaterinburg (geography).

## Inputs for the migration plan (next session)

- Deploy workflow needs new `HOST_IP_YC` / `SSH_PRIVATE_KEY_YC` secrets (names are YC-specific; consider renaming), user `skipper-admin`, `/home/skipper-admin/tmp`.
- Fix the DB-over-public-IP workaround on the new host instead of carrying it over (`docs/plans/20260925-close-db-public-exposure.md`).
- Data: `scripts/sync-db.js` for schema, then load `~/Web/dumps/outputfile-09-10-2026.sql`. Check whether the old DO droplet's Postgres (`134.122.73.229`) has anything newer worth merging before switching DNS.
- DNS is at reg.ru. Unverified blocker from the outage doc still stands: confirm the extension addresses the API by domain, not by `178.154.241.202`.
- Set up off-host scheduled `pg_dump` immediately after the move.
- Day-one test: curl the new IP on :3022 from a Russian phone on mobile data and from a home wired ISP.

## Sources

DO / TSPU: https://digitalpolicyalert.org/event/19120-announced-roskomnadzor-ban-of-digitalocean-llc-for-violating-local-operational-requirements, https://interfax.com/newsroom/top-stories/101357/, https://www.securitylab.ru/news/492749.php, https://habr.com/ru/news/667096/, https://ntc.party/t/17013, https://en.zona.media/article/2025/06/19/cloudflare, https://multihop.app/news/svoy-vpn-na-vps-ne-rabotaet-avgust-2026, https://vc.ru/services/3062910-massovyy-sboy-vpn-v-rossii-blokirovka-podsetey-hosting-provayderov, https://ebyebots.ru/blog/kak-tspu-roskomnadzora-lomaet-legitimnye-sajty-i-servery-v-iyune-2026-goda-tehnicheskij-razbor/, https://habr.com/ru/articles/1045684/, https://habr.com/ru/articles/1061502/, https://te-st.org/2026/05/12/hostingrules/

KZ / providers: https://ruvds.com/ru/data/almaty/, https://timeweb.cloud/services/servers-kz, https://timeweb.cloud/blog/oblachnye-servery-v-kazahstane, https://hostinghub.ru/timeweb-cloud, https://hostinghub.ru/ruvds, https://hosters.ru/ruvds/, https://vakas.ru/articles/ruvds-obzor/, https://vps-kazakhstan.vercel.app/, https://ruvds.com/ru/ruvds_belarus_2026/, https://yandex.cloud/en/docs/overview/concepts/region

152-FZ: https://companies.rbc.ru/news/SZRjtRsMIn/novyie-trebovaniya-k-obrabotke-personalnyih-dannyih-polnyij-gajd-na-2026-god/, https://kontur.ru/articles/55365-hosting_za_rubezhom, https://habr.com/en/news/781692

RF capacity: https://selectel.live/, https://habr.com/ru/articles/1093048/, https://www.kommersant.ru/doc/9023034, https://www.fontanka.ru/2026/10/11/76693413/, https://kazanfirst.ru/articles/ataka-na-dva-data-czentra-yandeksa-za-dve-nochi-hostery-zayavili-o-deficzite-rossijskih-serverov, https://timeweb.cloud/live, https://beget.com/ru/vps, https://selectel.ru/services/cloud/servers/, https://cloud.example.invalid/docs/ru/computing/iaas/tariffication, https://habr.com/ru/companies/ruvds/news/852444, https://kod.ru/runet-sboi-data-centr-yandex-2
