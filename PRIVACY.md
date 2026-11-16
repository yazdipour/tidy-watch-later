# Privacy Policy: Tidy Watch Later

_Effective 2026-11-16_

Tidy Watch Later is a browser extension that tidies your YouTube **Watch Later** playlist. This policy explains what data it handles. The short version: **it has no server of its own, collects nothing, and sends data only to the AI endpoint you configure yourself.**

## What the extension does with your data

### Data that stays in your browser
The extension saves the following in your browser's local extension storage (`chrome.storage.local`). By default none of it is synced to your browser account (Google or Microsoft), and it is never sent to the developer:

- your settings: endpoint URL, model name, and an API key if you choose to enter one;
- your tag list and each video's tags (keyed by YouTube video ID);
- your AI Filter request text and the match scores per video;
- the question limit discovered for your endpoint, and your preferences (limits, probability thresholds).

Your API key is stored **unencrypted** in that local storage. Don't reuse a valuable key.

### Optional: tag sync between your devices
**Off by default.** If you turn on **Sync tags between my devices** in Settings, the extension also copies the following into your browser's own sync storage (`chrome.storage.sync`):

- the YouTube video IDs you have tagged and the tag names on each (at most 3,000 videos; if you have more, the most recently tagged are kept);
- a timestamp, used to decide which device's copy is newer.

Your browser stores and transfers this through **its own account sync** (Google for Chrome, Microsoft for Edge), under that provider's privacy policy, and only if you are signed in to the browser with extension sync enabled. If you are not, nothing leaves the device. Chrome and Edge do not share it with each other. The developer never receives it. **Never synced:** your API key, endpoint URL, model name, AI Filter requests and scores, and any other setting. Turn the option off to stop syncing; copies already in your sync account are removed when you use **Clear all saved tags** with sync on, when you reset your browser's sync data (Google: `chrome.google.com/sync`; Microsoft: the Sync settings in Edge), or when you remove the extension.

### Data sent to your AI endpoint
The Tagging and AI Filter tools send data to **the endpoint URL you entered in Settings, and to nowhere else**. For each video that is scored, this is:

- the video title and channel name, read from the Watch Later page;
- the duration, the "views • age" text, how much of the video you have watched, and its position in the list;
- the YouTube video ID (it is part of each question's name);
- your tag names (Tagging) or your request text (AI Filter);
- your API key, as an `Authorization` header, only if you entered one.

The **Test connection** button sends one fixed sample sentence.

If your endpoint is a server on your own computer or network, this data never leaves your machines. If you point the extension at a hosted service, that service receives this data and handles it under **its own** privacy policy. Choosing the endpoint is your decision.

### Page content the extension reads
To work, the extension reads the Watch Later page you have open on youtube.com (video titles, channels, durations, progress bars) and adds tag chips and a filter bar to it. This happens entirely in your browser.

The **Delete Watched** and **Delete by Tag** tools remove videos by clicking YouTube's own "Remove from Watch later" menu item on your behalf. Nothing is sent anywhere for this.

## What the extension does not do

- It does not collect, store, or transmit data to the developer or any analytics, advertising, or tracking service.
- It does not sell or share your data, and does not use it for ads, credit decisions, or any purpose other than the features described above.
- It does not load or run remote code. All code is bundled in the extension.
- It does not read any site other than youtube.com, and only your own endpoint is contacted.

The use of information received from Google APIs and Chrome extension APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Permissions

| Permission | Why it is needed |
|---|---|
| `activeTab`, `scripting` | Run the delete tools on the Watch Later tab you are looking at, when you click the extension. |
| `storage` | Save your settings, tags and scores locally, and, only if you turn on tag sync, your tags in your browser's sync storage. |
| Content script on `https://www.youtube.com/*` | Show tag chips and the filter bar, and run the scans, on the Watch Later page. |
| Host access to `localhost` and `127.0.0.1` | Reach an AI server running on your own computer. |
| Optional access to other `http(s)` hosts | Requested **only** when you click Save or Test connection for an endpoint that is not on your computer. Chrome asks you to approve that single host. Nothing is granted before you approve. |

## Your control over the data

- **Delete tags:** use **Clear all saved tags** in the Tagging tab, or the ✕ on a tag chip. With sync on, this also clears the synced copy on your other devices.
- **Automatic cleanup:** when the Watch Later page has fully loaded, the extension forgets the tags and AI Filter scores of any video that is no longer in the list.
- **Stop the AI features:** leave the **Model** field in Settings empty (the AI tools then refuse to run), or remove the extension.
- **Remove everything:** uninstalling the extension deletes all of its stored data from your browser.
- **Revoke host access:** in `chrome://extensions`, open the extension's details and remove site access.

## Children

The extension is not directed at children and does not knowingly collect data from anyone.

## Changes to this policy

Changes are published in this file in the repository, and the effective date above is updated. The history is visible in the repository's commits.

## Contact

Questions or concerns: open an issue at <https://github.com/yazdipour/tidy-watch-later/issues>.
