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

// ----- Notification Ids -----

async function getNotificationId(downloadId) {
    const data = await getStorage("notificationIds");
    return data[downloadId] || 0;
}

async function setNotificationId(downloadId, count) {
    const data = await getStorage("notificationIds");
    data[downloadId] = count;
    await setStorage("notificationIds", data);
}

// ----- Cleanup -----

async function cleanup(downloadId) {
    const resumes = await getStorage("resumeAttempts");
    const retries = await getStorage("retryCounts");
    const notificationIds = await getStorage("notificationIds");

    delete resumes[downloadId];
    delete retries[downloadId];
    delete notificationIds[downloadId];

    await setStorage("resumeAttempts", resumes);
    await setStorage("retryCounts", retries);
    await setStorage("notificationIds", notificationIds);

    console.log(`Cleaned up state for download ID: ${downloadId}`);
}


// -------- Notification Helpers -------- //

/**
 * Create or update a progressive notification for ongoing download recovery.
 */
async function updateDownloadNotification(downloadId, title, message, isFinal = false) {
    let notifId = await getNotificationId(downloadId);

    if (!notifId) {
        notifId = `download_${downloadId}_${Date.now()}`;
        await setNotificationId(downloadId, notifId);
    }

    chrome.notifications.update(notifId, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("assets/icon128.png"),
        title,
        message,
        requireInteraction: isFinal  // keep final notifications visible
    }, wasUpdated => {
        if (!wasUpdated) {
            chrome.notifications.create(notifId, {
                type: "basic",
                iconUrl: chrome.runtime.getURL("assets/icon128.png"),
                title,
                message,
                requireInteraction: isFinal
            });
        }
    });

    if (isFinal) {
        // Auto-clear after a delay for final notifications
        setTimeout(async () => {
            chrome.notifications.clear(notifId);
            // Clear notification ID
            const notificationIds = await getStorage("notificationIds");
            delete notificationIds[downloadId];
            await setStorage("notificationIds", notificationIds);
        }, 8000);
    }
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

        await updateDownloadNotification(
            download.id,
            "Download Failed",
            `Max retries reached for ${download.filename}`,
            true
        );
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

            await updateDownloadNotification(
                newId,
                "Download Retried",
                `Retry ${newRetryCount} of ${MAX_RETRIES} for ${download.filename}`
            );
        } else {
            // Retry creation failed — exponential backoff
            console.error(`Failed to create retry for ${download.filename}: ${chrome.runtime.lastError?.message}`);
            const delay = Math.min(1000 * (2 ** retries), 30000);
            setTimeout(async () => await retryDownload(download), delay);
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

        await updateDownloadNotification(
            download.id,
            "Download Resume",
            `Resume attempt ${attempts} of ${MAX_RESUME_ATTEMPTS} successful for ${download.filename}`
        );
    } catch (err) {
        console.error(
            `Resume attempt #${attempts} failed for ${download.filename}: ${err.message}`
        );

        await updateDownloadNotification(
            download.id,
            "Download Interrupted",
            `Resume attempt ${attempts} of ${MAX_RESUME_ATTEMPTS} failed for ${download.filename}`
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

    if (delta.error?.current === "USER_CANCELED" || delta.error?.current === "canceled") {
        console.log(`Download canceled by user: ${delta.id}`);
        await cleanup(delta.id);
        await updateDownloadNotification(delta.id, "Download Cancelled", "The download was canceled", true);
        return;
    }

    if (delta.state?.current === "interrupted" || delta.error?.current === "NETWORK_FAILED") {
        const [download] = await chrome.downloads.search({ id: delta.id });
        if (!download) return;

        console.log(`Download interrupted: ${download.filename} ${download.id}`);
        await attemptResumeDownload(download);

    } else if (delta.state?.current === "complete") {
        await cleanup(delta.id);
        await updateDownloadNotification(delta.id, "Download Complete", "File has been successfully downloaded", true);
    } else if (delta.state?.current === "cancelled" || delta.exists === false) {
        await cleanup(delta.id);
        await updateDownloadNotification(delta.id, "Download Cancelled", "The download was canceled", true);
    }
});
