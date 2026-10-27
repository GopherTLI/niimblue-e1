# MakeID E1 support (unofficial)

This branch (`e1-support`) adds support for the **MakeID E1** Bluetooth label printer to
[NiimBlue](https://github.com/MultiMote/niimblue) by MultiMote (MIT license, see LICENSE).
Not affiliated with or endorsed by MakeID, WEWIN or NIIMBOT.

Protocol details and a Python driver: [open-e1-printer](https://github.com/GopherTLI/open-e1-printer).

## What's added

- **MakeID E1** connection option (Web Bluetooth, Chrome/Edge) with automatic reconnect to an
  already-allowed printer: `src/e1/e1_client.ts`.
- Printing to the E1: 96-dot head, LZO1X block format, 170-row blocks.
- **Auto length** (toolbar toggle): label length follows its content, text boxes grow instead of wrapping,
  with an adjustable end margin in mm. App-wide and remembered.
- Designer shading for the strips of 16 mm tape the 12 mm print head can't reach.
- Defaults tuned for the E1: 16 mm label height, Arial Rounded MT Bold text.

## Run

```bash
npm ci
npm run dev
```

Open http://localhost:5173 in Chrome or Edge, click **MakeID E1**, then the power button.
