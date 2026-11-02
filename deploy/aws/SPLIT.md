# Three agents and a router, instead of one program

This guide is for whoever puts this on the server. Commands are to copy and paste. Nothing here prints a key, token or phone number.

## What runs

| Service | System user | Data folder | Local port | Holds |
|---|---|---|---|---|
| `hisaab-agent@jcb` | `hisaab-jcb` | `/var/lib/hisaab-jcb` | 8081 | the JCB agent's key and ledger, the model key |
| `hisaab-agent@site` | `hisaab-site` | `/var/lib/hisaab-site` | 8082 | the contractor agent's key and ledger, the model key |
| `hisaab-agent@supplier` | `hisaab-supplier` | `/var/lib/hisaab-supplier` | 8083 | the supplier agent's key and ledger, the model key |
| `hisaab-router` | `hisaab-router` | `/var/lib/hisaab-router` | 8080 | WhatsApp tokens and app secrets, which messages were seen, the 24-hour windows; no key, no ledger |

Each data folder is 0700, readable only by its own user. Each agent has its settings in `/etc/hisaab/<name>.env` (0600, root; systemd reads them for it). Public addresses do not change: Caddy (`Caddyfile.services`) sends `/agents/<name>/…` to that agent and the rest to the router.

An agent refuses to start with another's key under its own file name, with any other file in its `keys` folder, with no key at all (it never makes one), or with the WhatsApp secrets in its settings.

**Memory.** The server has about 1.3 GB free. One process used about 80 MB. Expect about 80 MB for each agent and 50 to 60 MB for the router, so about 300 MB together at rest, about 220 MB more than today. The units slow an agent down at 250 MB and stop it at 350 MB (router: 150 MB and 250 MB), so one runaway service cannot take the others with it.

## Try it on a copy first

No system change. Make a copy of the data folder and the settings file in a private place on the server, then:

```
bash /opt/hisaab-bridge/deploy/aws/split-services.sh --copy <copy of data> <copy of hisaab.env> <empty folder>
```

The last line says `OK: …` or `NOT OK: …`. It checks each hash chain, that each ledger has the same rows and last hash as the source, every receipt and signature between the agents, and that each folder holds exactly its own key. To try the way back on those copies:

```
bash /opt/hisaab-bridge/deploy/aws/rollback-to-one.sh --copy <that folder>/hisaab- <another empty folder>
```

Delete the copies afterwards: they hold keys and ledgers.

## Put it live

Not while a job is going on. Open read-backs waiting for a plain "हाँ" are remembered only in memory and are lost at any restart, as at any update today.

1. Put the code in place, without restarting anything:
   ```
   sudo git -C /opt/hisaab-bridge fetch origin
   sudo git -C /opt/hisaab-bridge checkout --force <this version>
   ```
2. A backup that is yours alone: `sudo tar czf /root/hisaab-before-split.tgz /var/lib/hisaab /etc/hisaab /etc/caddy/Caddyfile`
3. `sudo bash /opt/hisaab-bridge/deploy/aws/split-services.sh --apply`

   It stops the service, copies and checks the data (if the check fails it starts the old service again and stops there), installs the units and the Caddyfile, starts the four, and checks that each one answers and that none can read another's key. **The service is down about one minute** (the copy takes seconds at today's size, the rest is starting). WhatsApp messages sent meanwhile are not lost: Meta sends them again.
4. From outside: `curl https://<your address>/health` says `ok`; the judge page opens; `/agents/jcb/.well-known/agent-card.json` shows the same public key as before.
5. Send "मदद" from one listed phone on each agent. Each should get its help text. `sudo journalctl -u hisaab-agent@site -n 20` should show `integrity: ok, 3 ledgers` within a couple of minutes.

To see what a service is doing: `sudo journalctl -u hisaab-router -f` (or `hisaab-agent@jcb`, `@site`, `@supplier`).

The old folder `/var/lib/hisaab` stays, with all three keys, readable only by root and the old `hisaab` user. Until it is gone, "each agent holds only its own key" is true of the running services and not of the disk. Once you are sure of the split, delete it and the backup:

```
sudo rm -rf /var/lib/hisaab
```

(The way back below works without it, as the keys are in the services' folders.)

## Go back to one program

`sudo bash /opt/hisaab-bridge/deploy/aws/rollback-to-one.sh --apply`

It stops the four, builds the one folder again from what they hold now, so nothing written since the split is lost, and checks it the same way. Only then it switches folders (the old one is kept as `/var/lib/hisaab.before-rollback-<time>`), puts back the old Caddyfile and starts `hisaab`. **The service is down about one minute.** This code also runs as one program, so no older version is needed. If the check fails it switches nothing and says so.

By hand, if the script itself cannot run:

1. `sudo systemctl disable --now hisaab-router hisaab-agent@jcb hisaab-agent@site hisaab-agent@supplier`
2. `cd /opt/hisaab-bridge && sudo node src/service/migrate.js back --from-prefix /var/lib/hisaab- --to /var/lib/hisaab.back` and read its last line.
3. `sudo mv /var/lib/hisaab /var/lib/hisaab.old && sudo mv /var/lib/hisaab.back /var/lib/hisaab && sudo chown -R hisaab:hisaab /var/lib/hisaab`
4. `sudo cp /opt/hisaab-bridge/deploy/aws/Caddyfile /etc/caddy/Caddyfile && sudo systemctl restart caddy`
5. `sudo systemctl enable --now hisaab`

The services' folders and `/etc/hisaab/{router,jcb,site,supplier}.env` stay behind. To split again later, move them aside first: the script refuses to write over them.

## When one service is down

- **An agent:** people of that agent are told "send it again" (the usual text); the others go on. Messages from the other agents wait and are delivered again every minute.
- **The router:** Caddy answers 502, Meta keeps the messages and sends them again. Notices the agents try to send meanwhile are kept and told when the person next writes.
- systemd restarts a service that fails.

## The ledger check

Every 6 hours and at start, each agent checks its own chain and asks each agent it deals with for a view of its ledger (signed request, `POST /agents/<name>/receipt-check`, 404 to anyone else). The contractor's agent shows the JCB agent nothing about the supplier beyond row numbers and hashes. It tells its own owner once per failure, in its own `wa.db`. If another agent is not up at start, it tries again every 2 minutes, up to 5 times, and in any case at the next 6-hourly check. The agents never read each other's files.
