
const MAX_RESUME_ATTEMPTS = 5;
const MAX_RETRIES = 3;

// Mapping: downloadId => currentResumeCount
const resumeAttempts = {};
// Mapping: downloadId => currentRetryCount
const retryCounts = {};

// Listen for download interruptions and try to resume if allowed
chrome.downloads.onChanged.addListener(delta => {
    if (delta.state && delta.state.current === "interrupted") {
        chrome.downloads.search({ id: delta.id }, downloads => {
            const dl = downloads[0];
            if (!dl) return;

            const currAttempts = resumeAttempts[delta.id] || 0;
            console.log(`Download interrupted: ${dl.filename}, Resume attempt ${currAttempts + 1}`);

            // Only try to resume up to the defined limit
            if (currAttempts < MAX_RESUME_ATTEMPTS) {
                console.log(`Resuming download: id=${dl.id}, Attempt ${currAttempts + 1}`);
                chrome.downloads.resume(dl.id, () => {
                    // Note: resume might fail if not resumable or if error
                    if (chrome.runtime.lastError) {
                        // If resume fails, try re-downloading
                        const prevTries = retryCounts[delta.id] || 0;

                        if (prevTries < MAX_RETRIES && dl.url) {
                            console.log(`Download failed to resume, retrying download: ${dl.filename}, Retry attempt ${prevTries + 1}`);
                            // Retry download with same URL and filename
                            retryCounts[delta.id] = prevTries + 1;
                            chrome.downloads.download(
                                {
                                    url: dl.url,
                                    filename: dl.filename,
                                    conflictAction: "overwrite" // same filename, overwrite existing partial
                                },
                                newId => {
                                    if (newId) {
                                        retryCounts[newId] = retryCounts[delta.id];
                                        delete retryCounts[delta.id]; // clean up old ID
                                    }
                                }
                            );
                        }
                    }
                    resumeAttempts[delta.id] = currAttempts + 1;
                });
            }
        });
    }
});

// Clean up counts when downloads successfully complete
chrome.downloads.onChanged.addListener(delta => {
    if (delta.state && delta.state.current === "complete") {
        delete resumeAttempts[delta.id];
        delete retryCounts[delta.id];
    }
});
