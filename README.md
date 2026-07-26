# JellyCast

JellyCast adds a **Resume here** action to Jellyfin Web's native Cast menu.
From any device signed in to the same account, it can retrieve video playback
from another device and resume at the same position.

## How it works

1. JellyCast injects its client script into Jellyfin Web's `index.html`
   response without modifying files on disk.
2. **Resume here** appears in the native Cast menu.
3. The plugin lists only active playback sessions associated with the current
   account, excluding technical sessions created by the current device.
4. JellyCast pauses the source, starts the media on the current device at the
   captured position, waits for playback confirmation, and then stops the
   source.

The media is still streamed directly by your Jellyfin server. JellyCast does
not relay the stream and does not send authentication tokens to external
services.

## Compatibility

- Jellyfin Server 10.11.x
- Jellyfin Web classic layout
- Target devices that accept Jellyfin remote playback commands

The Cast menu integration uses an unofficial Jellyfin Web extension point.
A major user-interface update may therefore require selector adjustments.
Native clients that do not embed Jellyfin Web will not show the JellyCast
action, but they can still participate when they expose compatible sessions.

Some clients, including certain Jellyfin Media Player versions, may report
active playback while declaring `SupportsRemoteControl: false`. JellyCast can
resume their media elsewhere, but those clients may ignore the automatic
Pause and Stop commands.

## Installation

In Jellyfin, open **Dashboard → Plugins → Repositories** and add:

```text
https://raw.githubusercontent.com/Railline/JellyCast/main/manifest.json
```

Open the plugin catalog, install JellyCast, and restart the Jellyfin server.

### Manual installation

1. Download the latest release archive or build the DLL.
2. Create a `JellyCast` directory inside Jellyfin's plugin directory.
3. Copy `Jellyfin.Plugin.JellyCast.dll` into that directory.
4. Restart Jellyfin and fully reload the web interface.

Build from source:

```bash
dotnet build --configuration Release
```

The DLL is generated under
`Jellyfin.Plugin.JellyCast/bin/Release/net9.0/`.

## Development

```bash
npm test
npm run check
dotnet build
```

## Security

JellyCast reuses the current Jellyfin client's authentication. Client-side
filtering restricts sources to the current account, while the Jellyfin server
still enforces remote-control permissions for every command.

## License

GPL-3.0-or-later.
