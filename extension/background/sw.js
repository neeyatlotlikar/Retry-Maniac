const MAX_RESUME_ATTEMPTS = 5;
const MAX_RETRIES = 3;
const NETWORK_PROBE_INTERVAL = 5000;


// -------- Helpers for persistent state -------- //

async function getStorage(key) {
    return new Promise(resolve => {
        chrome.storage.local.get(key, result => resolve(result[key] || {}));
    });
}

async function setStorage(key, value) {
    return new Promise(resolve => {
        chrome.storage.local.set({ [key]: value }, resolve);
    });
}

// ----- Resume Attempts -----

async function getResumeAttempts(downloadId) {
    const data = await getStorage("resumeAttempts");
    return data[downloadId] || 0;
}

async function setResumeAttempts(downloadId, count) {
    const data = await getStorage("resumeAttempts");
    data[downloadId] = count;
    await setStorage("resumeAttempts", data);
}

// ----- Retry Counts -----

async function getRetryCount(downloadId) {
    const data = await getStorage("retryCounts");
    return data[downloadId] || 0;
}

async function setRetryCount(downloadId, count) {
    const data = await getStorage("retryCounts");
    data[downloadId] = count;
    await setStorage("retryCounts", data);
}

// ----- Cleanup -----

async function cleanup(downloadId) {
    const resumes = await getStorage("resumeAttempts");
    const retries = await getStorage("retryCounts");

    delete resumes[downloadId];
    delete retries[downloadId];

    await setStorage("resumeAttempts", resumes);
    await setStorage("retryCounts", retries);

    console.log(`Cleaned up state for download ID: ${downloadId}`);
}


// -------- Network Helpers -------- //

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


// -------- Chrome Download Helpers -------- //

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
    const retries = await getRetryCount(download.id);
    if (retries >= MAX_RETRIES || !download.url) {
        console.error(`Max retries reached for ${download.filename}`);
        await cleanup(download.id);
        return;
    }

    const newRetryCount = retries + 1;

    chrome.downloads.download({
        url: download.url,
        filename: download.filename,
        conflictAction: "overwrite"
    }, async newId => {
        if (newId) {
            // Update retry count for new download
            await setRetryCount(newId, newRetryCount);
            await setResumeAttempts(newId, 0);

            // Remove old counts
            await cleanup(download.id);

            console.log(
                `Retry #${newRetryCount} started for ${download.filename}, new ID: ${newId}`
            );
        } else {
            // Retry creation failed — exponential backoff
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

    let attempts = (await getResumeAttempts(download.id)) + 1;
    await setResumeAttempts(download.id, attempts);

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

        if (attempts < MAX_RESUME_ATTEMPTS) {
            await waitForNetwork();
            await attemptResumeDownload(download);
        } else {
            console.warn(`Exhausted resume attempts for ${download.filename}, escalating to retry`);
            await retryDownload(download);
        }
    }
}


// -------- Event Listener -------- //

chrome.downloads.onChanged.addListener(async (delta) => {
    if (!("state" in delta) && !("error" in delta)) return;

    console.log(`Delta: state=${delta.state?.current}, error=${delta.error?.current}`);

    if (delta.state?.current === "interrupted" || delta.error?.current === "NETWORK_FAILED") {
        const [download] = await chrome.downloads.search({ id: delta.id });
        if (!download) return;

        console.log(`Download interrupted: ${download.filename}`);
        await attemptResumeDownload(download);

    } else if (["complete", "cancelled"].includes(delta.state?.current) || delta.exists === false) {
        await cleanup(delta.id);
    }
});
