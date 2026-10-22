# Run AICD on your Mac

Local AICD needs Node.js 22.13 or newer and npm. It does not require a domain, ChatGPT login, Cloudflare account, Supabase project or paid model API. Your Mac user account controls direct access to its saved files. While the server runs, any local process able to reach its loopback address can use the same local actor, including another local OS user's process. This is a single-user testing mode, not a password-protected team service.

## Start

Open Terminal and run:

```sh
cd /Users/simon/Documents/ChatGPT/Calendar/aicd
npm run local
```

Open **http://127.0.0.1:5173** in your browser. Keep the Terminal window open while using AICD. Press **Control+C** in that window to stop. Starting again with the same command reopens saved work. This checkout already has dependencies installed. For a fresh source download, first enter the extracted `aicd` folder and run `npm ci` once.

The launcher initializes local database/document storage and applies pending migrations. It binds to `127.0.0.1` with a fixed port (5173 by default; `npm run local -- --port 5174` selects a different loopback port). It rejects external origins, forwarded requests and non-loopback connections. A per-launch internal token protects the development Worker; you do not enter or manage it. The production build excludes local access mode. Do not use a tunnel, reverse proxy, port forwarding or `--host 0.0.0.0` to share this mode.

Choose **Tiếng Việt / English** in the interface. Open your imported shipment cases to inspect documents, conflicting values and review decisions. Shipments and Settings are the main navigation; Archive is a shipment filter. Review reports and the ECUS adapter are preparation/test features; no signing or customs submission occurs.

Import cases open in Review & draft, with **Thông tin chung 1 / General information 1**, **Thông tin chung 2 / General information 2** and **Danh sách hàng / Goods**. Select an indicator, enter its components, record applicability and supporting evidence, then choose Save draft or Save & review internally. Review & draft retains the commercial facts and goods checks. Documents provides original evidence; Messages shows imported shipment emails. Reports and history are secondary actions. This follows the vendor's published organization for familiarity; an exact ECUS5-VNACCS 2018 import template has not been verified.

## Where work is saved

- `.aicd-local/state/`: local database records and original document objects. This is separate from the old preview's `.wrangler` data and any hosted site.
- `.aicd-local/.dev.vars`: optional Z.ai secrets plus generated local runtime settings. It is private, ignored by Git and excluded from source downloads.
- Browser storage remembers the language preference. Unsaved edits are in memory; save them before reloading or closing the tab.

To back up data, stop AICD and copy the **whole `.aicd-local/state/` directory** to a private backup destination. To restore, stop AICD, preserve the current directory as a backup, then put the complete saved state directory back at that exact location. Do not copy individual SQLite files while the app is running. Back up optional secrets separately and privately. Source ZIPs intentionally contain neither shipment data nor secrets.

## Administrator GLM setup

GLM-5.3-Flash is the only live document extractor. PDFium renders PDF pages into images locally; it does not extract text or run OCR. After the owner enables GLM, document processing sends those images or text-file content to Z.ai. These requests use the internet and can incur Z.ai charges. End users do not configure a model or enter an API key.

1. Start AICD once, then stop it.
2. Open `.aicd-local/.dev.vars` in a local text editor. Preserve generated entries and set your key. The model setting below is the application's default and can be omitted:

```dotenv
ZAI_API_KEY=your_private_key
ZAI_MODEL=glm-5.3-flash
```

3. Restart with `npm run local`. The server reads these values from the private local file. A configuration check confirms only that settings exist; it does not test your account's balance or model access.
4. Keep the local server running while extracting documents. The automatic reader continues with the browser closed and processes two originals in parallel. New supported uploads and imported email attachments enter a durable queue; sample collections and reference-only files do not. Existing failed pages can be deliberately retried through their extraction action. The reader sends one page image per visual call, allows up to six provider calls per minute, and keeps its existing evidence checks. Switching providers does not retry saved failures.

Do not paste the API key into chat, browser fields or a public repository. No key is bundled. The endpoint is fixed to `https://api.z.ai/api/paas/v4`. The live model must be `glm-5.3-flash`, with low reasoning effort. There is no Moonshot fallback. The private file is ignored by Git, excluded from source ZIPs and restricted to the Mac file owner. Hosted login settings in the project's root `.env` and `.dev.vars` files remain ignored by `npm run local`.

An administrator may also supply `ZAI_API_KEY` and `ZAI_MODEL` through an already configured terminal environment. The launcher gives these values precedence over the private file and saves them in that file for future launches. Legacy Moonshot settings do not enable the live reader. It removes provider variables from Vite's process environment after staging the Worker secrets. An explicitly empty `ZAI_API_KEY` removes the saved key; otherwise remove its line from the private file to disable GLM, and restart. Do not enter secret values in commands that will be retained in shell history.

GLM also matches imported `.eml` email subjects and body text to current shipment references. Clear links are saved; uncertain links get individual review questions. Gmail synchronization is not connected. See [email shipment matching](email-shipment-grouping.md).

GLM proposes shipment facts and commercial goods rows. Application code validates evidence, reconciles candidates within a shipment, and fills an editable draft. An extraction result is never a human approval or a customs submission. Without a key, originals are saved and wait for GLM. No local OCR or deterministic extraction runs as a fallback. Existing historical results remain preserved, and manual correction is still available. Internal names such as `kimi.ts` and the saved `kimi:` evidence namespace remain for compatibility; each reading retains its actual model, and these names do not route requests to Moonshot.

## Troubleshooting and checks

- **Port 5173 already in use:** stop the other AICD/development server, then retry. The launcher deliberately does not silently switch URLs.
- **Blank/error page:** read Terminal output, check Node version with `node --version`, and use the exact `127.0.0.1` URL.
- **GLM unavailable:** confirm the Z.ai key and `ZAI_MODEL=glm-5.3-flash` in the private local file, then restart. Configuration status is not a live API health check; account/model access is unverified until a request succeeds.
- **New checkout has no saved cases:** source code and shipment data are separate. Restore your local state backup; do not expect a source ZIP to contain client records.

```sh
npm test
npm run typecheck
# Stop the local server first; production generation shares framework files.
npm run build
# Only against a separate, disposable workspace:
AICD_SMOKE_ISOLATED=1 node scripts/smoke-api.mjs http://127.0.0.1:5174
AICD_SMOKE_ISOLATED=1 node scripts/smoke-declaration.mjs http://127.0.0.1:5174
```

Run the smoke commands only against a separately started disposable AICD workspace; never point them at your shipment records. They add labelled synthetic verification records and exercise review, original-file storage, concurrency, structured declaration drafts and a simulated ECUS handoff. They do not call a real model, inbox or customs service.

## Hosting later

The intended team product will use Google sign-in and access approved by the owner. Those flows are still to be implemented. The source preserves the existing Supabase password adapter and Cloudflare deployment path in [standalone setup](standalone-setup.md). Before team use, configure HTTPS, verified identities, secrets, backups and access policy; migrate data with explicit identity mapping. Local mode cannot be deployed as an authentication bypass. No cloud provisioning, publishing or domain purchase is part of this local update.

## Pause background processing for inspection

Use `AICD_BACKGROUND_PROCESSING=0 npm run local` to run the local workspace without automatic document extraction or intake email matching. This leaves the saved provider key intact. Explicit manual AI actions still require deliberate use. Restart normally to resume pending queued pages. Successful pages, failures, rate-limit pauses and page timings are stored in the local SQLite database; failures wait for manual retry. No live Gmail synchronization or outgoing mail is performed.
