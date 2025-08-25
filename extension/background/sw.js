const MAX_RESUME_ATTEMPTS = 5;
const MAX_RETRIES = 3;
const NETWORK_PROBE_INTERVAL = 5000;

const iconUrl = chrome.runtime.getURL("assets/icon128.png");


// -------- Helpers for persistent state -------- //

async function getStorage(key) {
    return new Promise(resolve => {
        // Important to default to 0 if not found for value increments & conditions later
        chrome.storage.local.get(key, result => resolve(result[key] || 0));
    });
}

async function setStorage(key, value) {
    return new Promise(resolve => {
        chrome.storage.local.set({ [key]: value }, resolve);
    });
}

async function removeStorage(key) {
    return new Promise(resolve => {
        chrome.storage.local.remove(key, resolve);
    });
}

// ----- Generic Storage Accessor -----

/**
 * Get a value from `chrome.storage.local` for the given type and key.
 *
 * @param {string} type - The type of value to retrieve (e.g. "retryCounts", "resumeAttempts", etc.)
 * @param {number} key - The ID of the download to retrieve the value for
 *
 * @return {Promise<number>} The value associated with the type and key, or 0 if none.
 */
async function getStorageValue(type, key) {
    return await getStorage(`${type}_${key}`);
}

/**
 * Set a value in `chrome.storage.local` for the given type and key.
 *
 * @param {string} type - The type of value to set (e.g. "retryCounts", "resumeAttempts", etc.)
 * @param {number} key - The ID of the download to set the value for
 * @param {number} value - The value to set for the given type and key
 *
 * @return {Promise<void>} Resolves when the value has been set.
 */
async function setStorageValue(type, key, value) {
    await setStorage(`${type}_${key}`, value);
}

/**
 * Remove a value from `chrome.storage.local` for the given type and key.
 *
 * @param {string} type - The type of value to remove (e.g. "retryCounts", "resumeAttempts", etc.)
 * @param {number} key - The ID of the download to remove the value for
 *
 * @return {Promise<void>} Resolves when the value has been removed.
 */
async function removeStorageValue(type, key) {
    await removeStorage(`${type}_${key}`);
}

// ----- Resume Attempts -----

async function getResumeAttempts(downloadId) {
    return await getStorageValue("resumeAttempts", downloadId);
}

async function setResumeAttempts(downloadId, count) {
    await setStorageValue("resumeAttempts", downloadId, count);
}

// ----- Retry Counts -----

async function getRetryCount(downloadId) {
    return await getStorageValue("retryCounts", downloadId);
}

async function setRetryCount(downloadId, count) {
    await setStorageValue("retryCounts", downloadId, count);
}

// ----- Notification Ids -----

/**
 * Get the notification ID associated with a given download ID.
 *
 * @param {number} downloadId The ID of the download to get the notification ID for.
 *
 * @return {Promise<number>} Resolves with the notification ID associated with the download, or 0 if none.
 */
async function getNotificationId(downloadId) {
    return await getStorageValue("notificationIds", downloadId);
}

/**
 * Set the notification ID associated with a given download ID.
 * This is used to update or create a notification for a download.
 *
 * @param {number} downloadId The ID of the download to set the notification ID for.
 * @param {number} count The ID of the notification to set.
 */
async function setNotificationId(downloadId, count) {
    await setStorageValue("notificationIds", downloadId, count);
}

/**
 * Remove the notification ID associated with a given download ID.
 * @param {number} downloadId The ID of the download to remove the notification ID for.
 */
async function removeNotificationId(downloadId) {
    await removeStorageValue("notificationIds", downloadId);
}

// ----- Cleanup -----

/**
 * Clean up all state associated with a given download ID.
 * This removes state for retry counts, resume attempts, and notification IDs.
 * @param {number} downloadId The ID of the download to clean up state for.
 */
async function cleanup(downloadId) {
    const keys = ["resumeAttempts", "retryCounts", "notificationIds"].map(type => `${type}_${downloadId}`);
    // Remove all keys in one go
    await removeStorage(keys)
    console.log(`Cleaned up state for download ID: ${downloadId}`);
}


// -------- Notification Helpers -------- //


/**
 * Update an existing notification or create a new one for a given download ID.
 * The notification will be cleared after a delay (8 seconds) if isFinal is true.
 * @param {number} downloadId The ID of the download to associate the notification with.
 * @param {string} title The notification title.
 * @param {string} message The notification message.
 * @param {boolean} [isFinal=false] Whether this is a final notification and should be cleared after a delay.
 */
async function updateDownloadNotification(downloadId, title, message, isFinal = false) {
    let notifId = await getNotificationId(downloadId);

    if (!notifId) {
        notifId = `download_${downloadId}_${Date.now()}`;
        await setNotificationId(downloadId, notifId);
    }

    chrome.notifications.update(
        notifId,
        { type: "basic", iconUrl, title, message, requireInteraction: isFinal }
    ).then(wasUpdated => {
        if (!wasUpdated) {
            chrome.notifications.create(
                notifId,
                { type: "basic", iconUrl, title, message, requireInteraction: isFinal }
            );
        }
    });

    if (isFinal) {
        // Auto-clear after a delay for final notifications
        setTimeout(async () => {
            chrome.notifications.clear(notifId);
            // Clear notification ID
            await removeNotificationId(downloadId);
        }, 8000);
    }
}


// -------- Network Helpers -------- //

async function isNetworkReachable() {
    return navigator.onLine;
}

/**
 * Download may be interrupted due to network issues.
 * Ensure network availability before retrying.
 *
 * Waits for the network to be reachable by repeatedly polling using the
 * navigator.onLine property.
 *
 * @return {Promise<void>} Resolves when the network is back online.
 */
async function waitForNetwork() {
    while (!(await isNetworkReachable())) {
        console.log(`Network offline, retrying in ${NETWORK_PROBE_INTERVAL}ms`);
        await new Promise(resolve => setTimeout(resolve, NETWORK_PROBE_INTERVAL));
    }
    console.log("Network back online");
}


// -------- Chrome Download Helpers -------- //

/**
 * Resume a paused download.
 *
 * @param {number} downloadId The ID of the download to resume.
 *
 * @return {Promise<void>} Resolves when the download has been resumed, or rejects with the error if the resume attempt fails.
 */
function chromeDownloadsResumeAsync(downloadId) {
    return new Promise((resolve, reject) => {
        chrome.downloads.resume(downloadId, () => {
            chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve();
        });
    });
}


/**
 * Retry a failed download up to a maximum number of times.
 *
 * @param {Object} download The download object as returned by chrome.downloads.search.
 *
 * @return {Promise<void>} Resolves when the download has been retried, or the maximum retry count has been reached.
 *
 * If the retry count exceeds the maximum allowed, the download state is cleaned up and a notification is sent.
 * If the retry fails, an exponential backoff is performed until the next retry.
 * If the retry succeeds, the retry count for the new download is updated and the old counts are cleaned up.
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
        try {
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
                console.error(
                    `Failed to create retry for ${download.filename}: ${chrome.runtime.lastError?.message}`
                );

                const delay = Math.min(1000 * (2 ** retries), 30000);
                setTimeout(async () => await retryDownload(download), delay);
            }
        } catch (err) {
            console.error(`Error during retry for ${download.filename}: ${err}`);
        }
    });
}


/**
 * Attempt to resume a download that was interrupted.
 * Waits for the network to be reachable before retrying.
 * Retries up to MAX_RESUME_ATTEMPTS times on resume fails
 * before escalating to retryDownload.
 * @param {Object} download The download object to resume.
 */
async function attemptResumeDownload(download) {
    if (!(await isNetworkReachable())) {
        console.log(`Network unreachable for ${download.filename}`);
        await waitForNetwork();
    }

    try {
        await chromeDownloadsResumeAsync(download.id);
        console.log(`Resumed ${download.filename} (ID: ${download.id})`);

        await updateDownloadNotification(
            download.id,
            "Download Resume",
            `Resume attempt successful for ${download.filename}`
        );
    } catch (err) {
        let attempts = (await getResumeAttempts(download.id)) + 1;
        await setResumeAttempts(download.id, attempts);

        console.error(
            `Resume attempt #${attempts} of ${MAX_RESUME_ATTEMPTS} failed for ${download.filename}: ${err.message}`
        );

        await updateDownloadNotification(
            download.id,
            "Download Interrupted",
            `Resume attempt ${attempts} of ${MAX_RESUME_ATTEMPTS} failed for ${download.filename}`
        );

        if (attempts < MAX_RESUME_ATTEMPTS) {
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
        await updateDownloadNotification(delta.id, "Download Canceled", "The download was canceled", true);
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
