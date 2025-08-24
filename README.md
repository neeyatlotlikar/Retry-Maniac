# Retry Maniac: Auto Resume Downloads - Chrome Extension

**Retry Maniac: Auto Resume Downloads** is a lightweight Chrome extension that automatically detects interrupted downloads and attempts to resume them up to a configurable number of times. It also retries failed downloads gracefully with network connectivity checks, making your downloads more reliable even in flaky network conditions.

---

## Features

- Automatically resumes Chrome downloads that get interrupted due to network issues or server speed fluctuations.
- Retries downloads that fail to resume, up to a configurable maximum retry count.
- Performs network reachability checks before attempting to resume, waiting patiently for the connection to return if offline.
- Persistent retry/resume counts using `chrome.storage.local` for robust state tracking.
- Cleans up retry state when downloads complete, cancel, or are removed.
- Uses Chrome’s native downloads API — no external dependencies or native apps required.
- Minimal, non-interactive popup with clear usage description in dark theme.
- Browser notifications for download status tracking.
- Fully respects Chrome’s built-in download controls like pause, resume, and cancel.

---

## Installation

1. Download or clone this repository.

2. Open Chrome and go to `chrome://extensions`.

3. Enable **Developer mode** (toggle in the top right corner).

4. Click **Load unpacked** and select the project folder.

5. The extension icon will appear near the address bar. Downloads will now automatically retry as described.

---

## Usage

- Downloads start as usual via Chrome’s default behavior.

- If a download gets interrupted, the extension will check your network connectivity and repeatedly attempt to resume the download up to **5 times** (configurable).

- If resuming repeatedly fails, the extension will retry the whole download up to **3 times** (configurable), overwriting partial files.

- You can pause, resume, or cancel your downloads anytime directly in Chrome’s native Downloads tab (`chrome://downloads`).

---

## Configuration

Modify the following constants in `background.js` to customize behavior:

```js
const MAX_RESUME_ATTEMPTS = 5; // Maximum resume attempts per download
const MAX_RETRIES = 3; // Maximum full retry attempts if resume fails
const NETWORK_PROBE_INTERVAL = 5000; // Wait time before next network check
```

---

## How It Works

- The extension listens for download state changes via Chrome’s `downloads.onChanged` API.

- When a download is marked “interrupted,” it checks if the network is reachable using a fast browser-native check (`navigator.onLine`).

- If offline, it waits and polls every 5 seconds until network connectivity returns.

- Once online, it tries to resume the download using Chrome’s native `downloads.resume()` method.

- On resume failure, it initiates a full retry of the download, replacing partial files.

- Progress and errors are logged in the background service worker console for debugging.

---

## Development

- The extension uses a service worker background script (`sw.js`) for download management.

- Popup (`popup.html`) provides an informational interface in a sleek dark theme.

- Logs and debugging can be viewed by opening Chrome’s extensions page (`chrome://extensions`), enabling Developer Mode, and clicking the **service worker** link for this extension.

---

## Limitations

- Network reachability check uses `navigator.onLine` which reflects browser network status and is not 100% accurate.

- Resuming interrupted downloads depends on server support for HTTP range requests.

- Does not modify or override Chrome’s native download UI or controls.

---

## Future Enhancements

- Support user-configurable settings via the popup UI.

- Improve network reachability checks using content script probes or custom CORS-enabled endpoints.

---

## Contributions & Feedback

Feel free to submit issues or pull requests!  
For questions or suggestions, open an issue or contact the maintainer.

---

*Enjoy hassle-free downloads with Auto Resume Downloads!*
