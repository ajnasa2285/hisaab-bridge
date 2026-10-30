# Putting Hisaab Bridge on a server (AWS)

This guide is for the owner, not for programmers. You will copy and paste a few commands. You never need to put a password, key or token into a chat or into the GitHub repository. They go only into one file on the server.

## What you need

- An AWS EC2 instance running Ubuntu 24.04 or newer (a small one is enough). In its security group, open port 443. Port 80 is optional (the certificate is fetched over 443). SSH is not needed if the instance has an SSM role: use EC2 → Connect → Session Manager in the AWS console.
- Two WhatsApp test numbers in one Meta app (one for the JCB side, one for the site side). For each you need the phone number ID, and for the app the app secret and an access token.
- A Meta Model API key.
- For each person who will use the system: their phone number with country code, and their role.

## Steps

1. Open a terminal on the server: in the AWS console, EC2 → select the instance → Connect → Session Manager → Connect (or `ssh -i your-key.pem ubuntu@<server address>`). Then type `cd /tmp`.
2. Download and run the setup script (replace `main` with the version you want):

   ```
   curl -fsSLO https://raw.githubusercontent.com/ajnasa2285/hisaab-bridge/main/deploy/aws/setup.sh
   sudo bash setup.sh main
   ```

   It installs everything, and prints your web address, something like `https://203-0-113-10.sslip.io`. Running it again is safe. It never overwrites your settings file.
3. Fill in your settings: `sudo nano /etc/hisaab/hisaab.env`. Every empty line has a comment above it saying what goes there. For the two verify tokens, invent any long random text. Save with Ctrl+O, Enter, then leave with Ctrl+X.
4. Write the list of people: `sudo -u hisaab nano /var/lib/hisaab/people.json`. Copy the shape from `/opt/hisaab-bridge/deploy/aws/people.json.example`. Use `"line": "jcb"` or `"site"`, `"agent": "jcb"`, `"contractor"` or `"supplier"`, and a role of `jcb_owner`, `operator`, `contractor`, `supervisor` or `supplier` (role `supplier` always with agent `supplier`; the supplier usually writes to the JCB line, from a phone not already listed on that line). Phone numbers are digits only, with country code, for example `919000000001`. Optionally give a person `"site"`, the site they usually work on (a supervisor's one site): a JCB or material request from them that names no site is for that site, and they are not asked which.
5. Start it: `sudo systemctl restart hisaab`.

## Connecting each WhatsApp number in the Meta dashboard

Do this once for each number, in the Meta app dashboard under WhatsApp, Configuration, Webhook:

- JCB number: callback URL `https://<your address>/wa/jcb/webhook`
- Site number: callback URL `https://<your address>/wa/site/webhook`
- Supplier number (optional, only when the `HB_WA_SUPPLIER_*` lines are filled): callback URL `https://<your address>/wa/supplier/webhook`, verify token `HB_WA_SUPPLIER_VERIFY_TOKEN`
- Verify token: the same text you put in `HB_WA_JCB_VERIFY_TOKEN` (or `HB_WA_SITE_VERIFY_TOKEN`) in the settings file.
- Press Verify and save, then under webhook fields subscribe to `messages`.

## Checking that it works

- `curl https://<your address>/health` should answer `ok`.
- `sudo systemctl status hisaab` shows whether it is running.
- `sudo journalctl -u hisaab -f` shows what it is doing, live. Press Ctrl+C to stop watching.
- Send a WhatsApp message from one of the listed phones to the matching number.
- The judge page is at `https://<your address>/judge/`; to see the live ledgers on it, the viewer types the access key, which is `HB_EXPORT_TOKEN` from the settings file, shared privately (never in a chat, a link or the repository).

## Updating to a new version

Log in and run the setup script again with the new version name or tag:

```
sudo bash /opt/hisaab-bridge/deploy/aws/setup.sh <version>
sudo systemctl restart hisaab
```

Your settings, people list, keys and ledgers are kept. The script also installs the proxy settings (`deploy/aws/Caddyfile`) and restarts Caddy; updating with `git` alone does not, so the proxy would keep its old limits.

## Stopping

- Stop for now: `sudo systemctl stop hisaab`
- Start again: `sudo systemctl start hisaab`
- Stop it from starting at boot: `sudo systemctl disable hisaab`

The ledgers stay in `/var/lib/hisaab`. Back that folder up before deleting the server; it also holds the agents' private keys.

## Safety

- The settings file is readable only by the administrator. Never copy its content anywhere.
- If a token or key was shown somewhere it should not be, make a new one in Meta and replace it in the file.
- This repository is public: no real phone numbers, names, keys or tokens in it.
