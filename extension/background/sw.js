
const MAX_RESUME_ATTEMPTS = 5;
const MAX_RETRIES = 3;

// Mapping: downloadId => currentResumeCount
const resumeAttempts = {};
// Mapping: downloadId => currentRetryCount
const retryCounts = {};


/**
 * Checks if the current network connection is reachable.
 *
 * @return {Promise<boolean>} A Promise that resolves to a boolean indicating whether the network is reachable.
 */
async function isNetworkReachable() {
  return navigator.onLine;
}


/**
 * Waits for the network to come back online.
 *
 * @param {number} probeInterval - The interval in milliseconds to wait between network probes. Default is 5000.
 * @return {Promise<void>} A Promise that resolves when the network is back online.
 */
async function waitForNetwork(probeInterval = 5000) {
    while (true) {
        const reachable = await isNetworkReachable();
        if (reachable) {
            console.log("Network is back online.");
            break;
        } else {
            console.log("Still offline, retrying network probe in", probeInterval, "ms");
            await new Promise(resolve => setTimeout(resolve, probeInterval));
        }
    }
}


/**
 * Asynchronously resumes a download with the given ID using the Chrome Downloads API.
 * 
 * @param {number} downloadId - The ID of the download to resume.
 * @return {Promise<void>} - A Promise that resolves when the download is resumed successfully, or rejects
 * with an Error object if the operation fails.
 */
function chromeDownloadsResumeAsync(downloadId) {
    return new Promise((resolve, reject) => {
        chrome.downloads.resume(downloadId, () => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
        });
    });
}


/**
 * Attempts to resume a download, waiting for network to come back online if necessary,
 * and retries the download if the resume fails.
 *
 * @param {Object} dl - The download object to resume, containing the download ID and filename.
 * @return {Promise<void>} - A Promise that resolves when the download is successfully resumed,
 * or rejects if the resume fails and the retry attempt also fails.
 */
async function attemptResumeDownload(dl) {
    const reachable = await isNetworkReachable();
    if (!reachable) {
        console.log(`Network unreachable, waiting before resuming download id=${dl.id}`);
        await waitForNetwork();
    }

    console.log(`Attempting to resume download: ${dl.filename}, ID: ${dl.id}`);

    try {
        await chromeDownloadsResumeAsync(dl.id);
        console.log(`Resume succeeded for download id=${dl.id}`);
    } catch (err) {
        console.error(`Resume failed for download id=${dl.id}`, err.message);
        await attemptRetryDownload(dl);
    }
}

/**
 * Attempts to retry a download by creating a new download with the same URL and filename.
 * If the download fails to resume, it will be retried up to a maximum number of times.
 *
 * @param {Object} dl - The download object to retry, containing the download ID, URL, and filename.
 * @return {Promise<void>} - A Promise that resolves when the download is successfully retried,
 * or rejects if the retry attempt also fails.
 */
async function attemptRetryDownload(dl) {
    const prevTries = retryCounts[dl.id] || 0;

    if (prevTries < MAX_RETRIES && dl.url) {
        console.log(`Download failed to resume, retrying download: ${dl.filename}, Retry attempt ${prevTries + 1}`);
        // Retry download with same URL and filename
        retryCounts[dl.id] = prevTries + 1;
        chrome.downloads.download(
            {
                url: dl.url,
                filename: dl.filename,
                conflictAction: "overwrite" // same filename, overwrite existing partial
            },
            newId => {
                if (newId) {
                    const tries = retryCounts[dl.id];
                    retryCounts[newId] = tries;
                    delete retryCounts[dl.id]; // clean up old ID
                } else {
                    console.error(`Failed to restart download: ${dl.filename}`);
                }
            }
        );
    }
}

// Listen for download interruptions and try to resume if allowed with network check
chrome.downloads.onChanged.addListener(async (delta) => {
    if (delta.state) {
        if (delta.state.current === "interrupted") {
            chrome.downloads.search({ id: delta.id }, async (downloads) => {
                const dl = downloads[0];
                if (!dl) return;

                const currAttempts = resumeAttempts[delta.id] || 0;
                console.log(`Download interrupted: ${dl.filename}, Resume attempt ${currAttempts + 1}`);

                // Only try to resume up to the defined limit
                if (currAttempts < MAX_RESUME_ATTEMPTS) {
                    resumeAttempts[delta.id] = currAttempts + 1;
                    console.log(`Resuming download: id=${dl.id}, Attempt ${currAttempts + 1}`);
                    await attemptResumeDownload(dl);
                } else {
                    console.warn(`Max resume attempts reached for download ${delta.id}. No further tries.`);
                }
            });
        } else if (delta.state.current === 'complete' || delta.state.current === 'cancelled' || delta.exists === false) {
            // Cleanup tracking for completed, cancelled downloads, or non-existent (removed) downloads
            delete resumeAttempts[delta.id];
            delete retryCounts[delta.id];
        }
    }
});
