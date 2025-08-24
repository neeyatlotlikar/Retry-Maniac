const MAX_RESUME_ATTEMPTS = 5;
const MAX_RETRIES = 3;
const NETWORK_PROBE_INTERVAL = 5000;

// Track attempts: { downloadId: count }
const resumeAttempts = new Map();
const retryCounts = new Map();

async function isNetworkReachable() {
    return navigator.onLine;
}

async function waitForNetwork() {
    while (!(await isNetworkReachable())) {
        console.log(`Network offline, retrying in ${NETWORK_PROBE_INTERVAL}ms`);
        await new Promise(resolve => setTimeout(resolve, NETWORK_PROBE_INTERVAL));
    }
    console.log("Network back online");
}

function chromeDownloadsResumeAsync(downloadId) {
    return new Promise((resolve, reject) => {
        chrome.downloads.resume(downloadId, () => {
            chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve();
        });
    });
}

/**
 * Attempt to retry by creating a new download, and reset resume count.
 */
async function retryDownload(download) {
    const retries = retryCounts.get(download.id) || 0;
    if (retries >= MAX_RETRIES || !download.url) {
        console.error(`Max retries reached for ${download.filename}`);
        cleanup(download.id);
        return;
    }

    const newRetryCount = retries + 1;

    chrome.downloads.download({
        url: download.url,
        filename: download.filename,
        conflictAction: "overwrite"
    }, newId => {
        if (newId) {
            // Transfer retry count to new download id
            retryCounts.set(newId, newRetryCount);
            retryCounts.delete(download.id);

            // Reset resume attempt count for the fresh download
            resumeAttempts.set(newId, 0);

            console.log(
                `Retry #${newRetryCount} started for ${download.filename}, new ID: ${newId}`
            );
        } else {
            // Retry creation failed — apply exponential backoff
            console.error(`Failed to create retry for ${download.filename}: ${chrome.runtime.lastError?.message}`);
            const delay = Math.min(1000 * (2 ** retries), 30000);
            setTimeout(() => retryDownload(download), delay);
        }
    });
}

/**
 * Attempt to resume a download if possible, otherwise escalate to retry.
 */
async function attemptResumeDownload(download) {
    if (!(await isNetworkReachable())) {
        console.log(`Network unreachable for ${download.filename}`);
        await waitForNetwork();
    }

    const attempts = (resumeAttempts.get(download.id) || 0) + 1;
    resumeAttempts.set(download.id, attempts);

    if (attempts > MAX_RESUME_ATTEMPTS) {
        console.warn(`Max resume attempts reached for ${download.filename}`);
        await retryDownload(download);
        return;
    }

    try {
        await chromeDownloadsResumeAsync(download.id);
        console.log(`Resumed ${download.filename} (ID: ${download.id}) [Attempt ${attempts}]`);
    } catch (err) {
        console.error(
            `Resume attempt #${attempts} failed for ${download.filename}: ${err.message}`
        );
        // Wait for network and try again unless we've already exhausted
        if (attempts < MAX_RESUME_ATTEMPTS) {
            await waitForNetwork();
            await attemptResumeDownload(download);
        } else {
            console.warn(`Exhausted resume attempts for ${download.filename}, escalating to retry`);
            await retryDownload(download);
        }
    }
}

/**
 * Cleanup tracking maps after completion/cancelation/failure
 */
function cleanup(downloadId) {
    resumeAttempts.delete(downloadId);
    retryCounts.delete(downloadId);
    console.log(`Cleaned up state for download ID: ${downloadId}`);
}

chrome.downloads.onChanged.addListener(async (delta) => {
    if (!("state" in delta) && !("error" in delta)) return;

    console.log(`Delta: state=${delta.state?.current}, error=${delta.error?.current}`);

    if (delta.state?.current === "interrupted" || delta.error?.current === "NETWORK_FAILED") {
        const [download] = await chrome.downloads.search({ id: delta.id });
        if (!download) return;

        console.log(`Download interrupted: ${download.filename}`);
        await attemptResumeDownload(download);

    } else if (["complete", "cancelled"].includes(delta.state?.current) || delta.exists === false) {
        cleanup(delta.id);
    }
});
