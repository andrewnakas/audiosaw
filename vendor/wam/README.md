# WebAudioModules host SDK

The host half of `@webaudiomodules/sdk` 0.0.12 (API 2.0.0-alpha.6), copied
unmodified from `src/`: `initializeWamHost` and the four files it imports.
That is all a host needs; each plugin ships its own copy of the rest of the SDK.

The files import each other without a `?v=`, so an upgrade goes in a new
version folder (`vendor/wam/<version>/`) rather than over these, and
`js/wam-host.js` points at it.
